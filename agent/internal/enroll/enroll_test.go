package enroll

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

type fakePlatform struct {
	caKey  *ecdsa.PrivateKey
	caCert *x509.Certificate
	caPEM  string
	swap   bool // return a certificate for a different key
}

func newPlatform(t *testing.T) *fakePlatform {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &fakePlatform{caKey: key, caCert: cert, caPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

func (p *fakePlatform) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req map[string]string
	_ = json.NewDecoder(r.Body).Decode(&req)
	if r.URL.Path != "/api/enroll" || req["token"] != "dtk_valid" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"detail": "enrollment token is invalid, expired or used up"})
		return
	}
	block, _ := pem.Decode([]byte(req["csr"]))
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	pub := csr.PublicKey
	if p.swap {
		other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		pub = &other.PublicKey
	}
	agentID := "0123456789abcdef0123456789abcdef"
	der, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: agentID},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}},
		p.caCert, pub, p.caKey)
	_ = json.NewEncoder(w).Encode(map[string]string{"agent_id": agentID, "server_address": "twin.example:8443", "server_name": "ingestion.local",
		"certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), "issuer_certificate": p.caPEM, "ca_certificate": p.caPEM})
}

func TestEnrollWritesWorkingIdentity(t *testing.T) {
	platform := newPlatform(t)
	server := httptest.NewTLSServer(platform)
	defer server.Close()
	dir := t.TempDir()
	id, cfgPath, err := Run(Options{URL: server.URL, Token: "dtk_valid", Dir: dir, Hostname: "db01", Client: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if id != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("agent id %q", id)
	}
	var cfg fileConfig
	raw, _ := os.ReadFile(cfgPath)
	if err := yaml.Unmarshal(raw, &cfg); err != nil || cfg.ServerAddress != "twin.example:8443" || cfg.TLS.ServerName != "ingestion.local" {
		t.Fatalf("config %+v %v", cfg, err)
	}
	if info, err := os.Stat(filepath.Join(dir, "agent.key")); err != nil || (info.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/') {
		t.Fatalf("private key must be private: %v", err)
	}
	// A second enrollment must not silently replace this machine's identity.
	if _, _, err := Run(Options{URL: server.URL, Token: "dtk_valid", Dir: dir, Client: server.Client()}); err == nil || !strings.Contains(err.Error(), "already enrolled") {
		t.Fatalf("expected refusal to overwrite, got %v", err)
	}
}

func TestEnrollRejectsBadTokensInsecureURLsAndForeignCertificates(t *testing.T) {
	platform := newPlatform(t)
	server := httptest.NewTLSServer(platform)
	defer server.Close()
	if _, _, err := Run(Options{URL: server.URL, Token: "dtk_wrong", Dir: t.TempDir(), Client: server.Client()}); err == nil || !strings.Contains(err.Error(), "invalid, expired") {
		t.Fatalf("expected server refusal, got %v", err)
	}
	if _, _, err := Run(Options{URL: "http://twin.example.com", Token: "dtk_valid", Dir: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected HTTPS requirement, got %v", err)
	}
	if _, _, err := Run(Options{URL: server.URL, Token: "not-a-token", Dir: t.TempDir(), Client: server.Client()}); err == nil {
		t.Fatal("expected token format check")
	}
	platform.swap = true
	dir := t.TempDir()
	if _, _, err := Run(Options{URL: server.URL, Token: "dtk_valid", Dir: dir, Client: server.Client()}); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected key mismatch rejection, got %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatal("nothing may be written after a rejected enrollment")
	}
}
