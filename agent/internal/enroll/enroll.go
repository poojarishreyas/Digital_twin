// Package enroll exchanges a short-lived enrollment token for an agent identity.
//
// The private key is generated locally and never leaves the machine; only a
// certificate signing request and the token are sent. The server chooses the
// agent ID and returns a client certificate bound to one customer workspace.
package enroll

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Options struct {
	URL       string // platform base URL, e.g. https://twin.example.com
	Token     string // dtk_... enrollment token from the dashboard
	Dir       string // where key, certificates and config.yaml are written
	Hostname  string
	AllowHTTP bool // lab only: permit plain HTTP to a non-loopback platform
	Force     bool // replace an existing identity in Dir
	Client    *http.Client
}

type response struct {
	AgentID           string `json:"agent_id"`
	Certificate       string `json:"certificate"`
	IssuerCertificate string `json:"issuer_certificate"`
	CACertificate     string `json:"ca_certificate"`
	ServerAddress     string `json:"server_address"`
	ServerName        string `json:"server_name"`
	Detail            string `json:"detail"`
}

type fileConfig struct {
	ServerAddress string `yaml:"server_address"`
	TLS           struct {
		CA          string `yaml:"ca"`
		Certificate string `yaml:"certificate"`
		Key         string `yaml:"key"`
		ServerName  string `yaml:"server_name"`
	} `yaml:"tls"`
}

// Run enrolls this machine and returns the agent ID and the path of the written config.
func Run(o Options) (string, string, error) {
	base, err := url.Parse(strings.TrimRight(o.URL, "/"))
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", "", errors.New("platform URL must look like https://twin.example.com")
	}
	loopback := base.Hostname() == "localhost" || base.Hostname() == "127.0.0.1" || base.Hostname() == "::1"
	if base.Scheme != "https" && !(base.Scheme == "http" && (loopback || o.AllowHTTP)) {
		return "", "", errors.New("enrollment requires HTTPS (use -allow-http only inside an isolated lab)")
	}
	if !strings.HasPrefix(o.Token, "dtk_") || len(o.Token) > 256 {
		return "", "", errors.New("enrollment token must start with dtk_")
	}
	dir, err := filepath.Abs(o.Dir)
	if err != nil {
		return "", "", err
	}
	paths := map[string]string{"key": filepath.Join(dir, "agent.key"), "cert": filepath.Join(dir, "agent.crt"),
		"ca": filepath.Join(dir, "ca.crt"), "config": filepath.Join(dir, "config.yaml")}
	if !o.Force {
		for _, p := range paths {
			if _, err := os.Stat(p); err == nil {
				return "", "", fmt.Errorf("%s already exists; this machine is already enrolled (use -force to replace its identity)", p)
			}
		}
	}
	if o.Hostname == "" {
		o.Hostname, _ = os.Hostname()
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "pending-enrollment"}}, key)
	if err != nil {
		return "", "", err
	}
	body, _ := json.Marshal(map[string]string{"token": o.Token, "hostname": o.Hostname, "os": runtime.GOOS,
		"csr": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))})
	client := o.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("enrollment does not follow redirects")
		}}
	}
	resp, err := client.Post(base.String()+"/api/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", "", fmt.Errorf("contact platform: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return "", "", err
	}
	var r response
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", "", fmt.Errorf("platform returned HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("enrollment refused (HTTP %d): %s", resp.StatusCode, r.Detail)
	}
	if err := verify(r, key); err != nil {
		return "", "", err
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", "", err
	}
	var cfg fileConfig
	cfg.ServerAddress = r.ServerAddress
	cfg.TLS.CA, cfg.TLS.Certificate, cfg.TLS.Key, cfg.TLS.ServerName = paths["ca"], paths["cert"], paths["key"], r.ServerName
	cfgYAML, _ := yaml.Marshal(cfg)
	files := []struct {
		path string
		data []byte
		mode os.FileMode
	}{
		{paths["key"], pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600},
		{paths["cert"], []byte(r.Certificate), 0o644},
		{paths["ca"], []byte(r.CACertificate), 0o644},
		{paths["config"], append([]byte("# Written by twin-agent enroll. Agent ID: "+r.AgentID+"\n"), cfgYAML...), 0o600},
	}
	for _, f := range files {
		if err := writeAtomic(f.path, f.data, f.mode); err != nil {
			return "", "", err
		}
	}
	return r.AgentID, paths["config"], nil
}

func verify(r response, key *ecdsa.PrivateKey) error {
	block, _ := pem.Decode([]byte(r.Certificate))
	if block == nil || block.Type != "CERTIFICATE" {
		return errors.New("platform returned no certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("parse issued certificate: %w", err)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return errors.New("issued certificate does not match this machine's key")
	}
	if cert.Subject.CommonName != r.AgentID || len(r.AgentID) < 16 || len(r.AgentID) > 128 {
		return errors.New("issued certificate does not carry the assigned agent ID")
	}
	if issuerBlock, _ := pem.Decode([]byte(r.IssuerCertificate)); issuerBlock != nil {
		issuer, err := x509.ParseCertificate(issuerBlock.Bytes)
		if err != nil || cert.CheckSignatureFrom(issuer) != nil {
			return errors.New("issued certificate is not signed by the stated issuer")
		}
	}
	if caBlock, _ := pem.Decode([]byte(r.CACertificate)); caBlock == nil || r.ServerAddress == "" {
		return errors.New("platform response is missing the server CA or address")
	}
	return nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
