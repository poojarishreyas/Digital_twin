package parsers

import (
	"strings"
	"testing"
)

func TestPostgresOrderAndRedaction(t *testing.T) {
	p, err := Parse("postgresql", "postgresql.conf", "port = 5432\npassword_encryption = 'scram-sha-256'\nport = 5433\nssl = on\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Directives) != 4 {
		t.Fatalf("got %d directives", len(p.Directives))
	}
	if p.Directives[0].Order != 1 || p.Directives[2].Order != 3 {
		t.Fatal("directive order not preserved")
	}
	if p.Directives[1].Values[0] != "scram-sha-256" {
		t.Fatalf("security policy value was lost: %q", p.Directives[1].Values[0])
	}
}

func TestHBAOrderPreserved(t *testing.T) {
	input := "local all all peer\nhostssl app appuser 10.0.0.0/8 scram-sha-256\nhost all all 0.0.0.0/0 ldap ldapbindpasswd=seeded-secret\n"
	p, _ := Parse("pg_hba", "pg_hba.conf", input)
	if len(p.Directives) != 3 {
		t.Fatalf("got %d rules", len(p.Directives))
	}
	for i, d := range p.Directives {
		if d.Order != i+1 {
			t.Fatalf("rule %d order=%d", i, d.Order)
		}
	}
	last := strings.Join(p.Directives[2].Values, " ")
	if strings.Contains(last, "seeded-secret") || !strings.Contains(last, "ldapbindpasswd=<redacted>") {
		t.Fatalf("pg_hba option was not sanitized: %s", last)
	}
	if !strings.Contains(strings.Join(p.Directives[1].Values, " "), "scram-sha-256") {
		t.Fatal("authentication method was lost")
	}
}

func TestNginxRepeatedDirectives(t *testing.T) {
	p, _ := Parse("nginx", "nginx.conf", "http { server { listen 80; listen 443 ssl; server_tokens off; } }")
	if len(p.Directives) != 3 {
		t.Fatalf("expected repeated listen directives, got %#v", p.Directives)
	}
	if p.Directives[0].Name != "listen" || p.Directives[1].Name != "listen" {
		t.Fatal("listen order lost")
	}
	if p.Directives[2].Values[0] != "off" {
		t.Fatal("server_tokens is a security policy, not an authentication token")
	}
}

func TestRedisOnlyAllowlisted(t *testing.T) {
	p, _ := Parse("redis", "redis.conf", "bind 127.0.0.1\nrequirepass seeded-secret\nprotected-mode yes\n")
	if len(p.Directives) != 3 {
		t.Fatalf("expected safe settings plus redacted auth marker: %#v", p.Directives)
	}
	for _, d := range p.Directives {
		if strings.Contains(strings.Join(d.Values, " "), "seeded-secret") {
			t.Fatal("secret exported")
		}
	}
	if p.Directives[1].Name != "requirepass" || p.Directives[1].Values[0] != "<redacted>" {
		t.Fatal("Redis authentication marker must be retained without its secret")
	}
}

func TestOpenSSHMatchSections(t *testing.T) {
	p, _ := Parse("openssh", "sshd_config", "PasswordAuthentication no\nMatch User deploy\n  PasswordAuthentication yes\n")
	if len(p.Directives) != 3 {
		t.Fatalf("expected Match plus scoped directive: %#v", p.Directives)
	}
	if p.Directives[2].Section != "User deploy" {
		t.Fatalf("match scope missing: %#v", p.Directives[2])
	}
}
