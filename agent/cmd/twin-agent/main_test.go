package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testCertificate(t *testing.T, path, commonName string) {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: commonName},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, private)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestCertificatePinsStableAgentID(t *testing.T) {
	dir := t.TempDir()
	certificate := filepath.Join(dir, "agent.crt")
	identity := filepath.Join(dir, "state", "agent-id")
	id := "0123456789abcdef0123456789abcdef"
	testCertificate(t, certificate, id)
	got, err := loadOrCreateID(identity, certificate)
	if err != nil || got != id {
		t.Fatalf("first identity: got %q, error %v", got, err)
	}
	testCertificate(t, certificate, "fedcba9876543210fedcba9876543210")
	if _, err := loadOrCreateID(identity, certificate); err == nil {
		t.Fatal("certificate change silently changed stable agent identity")
	}
	testCertificate(t, certificate, "lab-agent")
	if _, err := loadOrCreateID(filepath.Join(dir, "other-id"), certificate); err == nil {
		t.Fatal("short shared certificate identity was accepted")
	}
}
