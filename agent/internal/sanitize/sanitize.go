package sanitize

import (
	"regexp"
	"strings"
)

const Redacted = "<redacted>"

var secretName = regexp.MustCompile(`(?i)(password|passwd|requirepass|secret|token|private[_-]?key|credential|community|auth[_-]?key)`)
var credentialURL = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://[^:/\s]+:)[^@/\s]+(@)`)
var pemBlock = regexp.MustCompile(`(?s)-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----`)

var policyDirective = map[string]bool{
	"server_tokens":          true,
	"passwordauthentication": true,
	"password_encryption":    true,
	"pubkeyauthentication":   true,
	"authenticationmethods":  true,
	"tls-auth-clients":       true,
}

func IsSecretDirective(name string) bool {
	if policyDirective[strings.ToLower(name)] {
		return false
	}
	return secretName.MatchString(name)
}

func Value(name, value string) string {
	if IsSecretDirective(name) {
		return Redacted
	}
	value = credentialURL.ReplaceAllString(value, `${1}`+Redacted+`${2}`)
	value = pemBlock.ReplaceAllString(value, Redacted)
	return value
}

func Text(value string) string {
	value = credentialURL.ReplaceAllString(value, `${1}`+Redacted+`${2}`)
	value = pemBlock.ReplaceAllString(value, Redacted)
	for _, marker := range []string{"password=", "passwd=", "token=", "secret="} {
		if i := strings.Index(strings.ToLower(value), marker); i >= 0 {
			end := strings.IndexAny(value[i+len(marker):], " \t\r\n;&")
			if end < 0 {
				end = len(value) - i - len(marker)
			}
			value = value[:i+len(marker)] + Redacted + value[i+len(marker)+end:]
		}
	}
	return value
}
