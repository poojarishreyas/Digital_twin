package sanitize

import (
	"strings"
	"testing"
)

func TestSecretsNeverSurvive(t *testing.T) {
	for _, tc := range []struct{ name, value string }{
		{"password", "seeded-secret"}, {"url", "postgres://user:seeded-secret@db/app"}, {"private_key", "seeded-secret"},
	} {
		got := Value(tc.name, tc.value)
		if strings.Contains(got, "seeded-secret") {
			t.Fatalf("secret survived in %s: %s", tc.name, got)
		}
	}
}

func TestSecurityPolicyIsNotMistakenForSecret(t *testing.T) {
	if got := Value("PasswordAuthentication", "no"); got != "no" {
		t.Fatalf("policy directive was redacted: %q", got)
	}
}
