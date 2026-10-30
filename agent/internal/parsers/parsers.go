package parsers

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/example/digital-twin/agent/internal/sanitize"
)

type Directive struct {
	Order   int      `json:"order"`
	Section string   `json:"section,omitempty"`
	Name    string   `json:"name"`
	Values  []string `json:"values"`
	Source  string   `json:"source"`
	Line    int      `json:"line"`
}

type Parsed struct {
	Format      string      `json:"format"`
	Directives  []Directive `json:"directives"`
	Unsupported []string    `json:"unsupported_directives,omitempty"`
}

var allow = map[string]map[string]bool{
	"nginx":      set("user", "worker_processes", "listen", "server_name", "ssl_protocols", "ssl_ciphers", "client_max_body_size", "proxy_pass", "proxy_ssl_verify", "add_header", "server_tokens", "limit_req", "allow", "deny"),
	"postgresql": set("listen_addresses", "port", "ssl", "ssl_min_protocol_version", "password_encryption", "log_connections", "log_disconnections", "logging_collector", "shared_preload_libraries", "max_connections", "unix_socket_permissions"),
	"redis":      set("bind", "protected-mode", "port", "requirepass", "tls-port", "tls-auth-clients", "rename-command", "aclfile", "unixsocketperm", "maxmemory-policy"),
	"openssh":    set("port", "listenaddress", "permitrootlogin", "passwordauthentication", "pubkeyauthentication", "authenticationmethods", "allowusers", "allowgroups", "denyusers", "denygroups", "x11forwarding", "allowtcpforwarding", "permitopen", "gatewayports", "usepam", "loglevel", "ciphers", "macs", "kexalgorithms", "match"),
}

func set(v ...string) map[string]bool {
	m := map[string]bool{}
	for _, x := range v {
		m[x] = true
	}
	return m
}

func ParseFile(service, path string) (Parsed, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Parsed{}, err
	}
	return Parse(service, filepath.Base(path), string(b))
}

func Parse(service, source, content string) (Parsed, error) {
	switch strings.ToLower(service) {
	case "nginx":
		return parseNginx(source, content), nil
	case "postgresql":
		return parseKV(service, source, content, "="), nil
	case "pg_hba":
		return parseHBA(source, content), nil
	case "redis", "openssh":
		return parseKV(service, source, content, ""), nil
	default:
		return Parsed{}, fmt.Errorf("unsupported parser %q", service)
	}
}

func cleanValue(name, value string) string {
	return sanitize.Value(name, strings.Trim(strings.TrimSpace(value), "\"'"))
}

func parseKV(service, source, content, separator string) Parsed {
	out := Parsed{Format: service}
	s := bufio.NewScanner(strings.NewReader(content))
	line, order, section := 0, 0, ""
	for s.Scan() {
		line++
		raw := strings.TrimSpace(stripComment(s.Text()))
		if raw == "" {
			continue
		}
		var name, rest string
		if separator != "" && strings.Contains(raw, separator) {
			p := strings.SplitN(raw, separator, 2)
			name, rest = strings.TrimSpace(p[0]), strings.TrimSpace(p[1])
		} else {
			p := strings.Fields(raw)
			if len(p) < 2 {
				continue
			}
			name, rest = p[0], strings.Join(p[1:], " ")
		}
		key := strings.ToLower(name)
		if service == "openssh" && key == "match" {
			section = rest
		}
		if !allow[service][key] {
			out.Unsupported = append(out.Unsupported, key)
			continue
		}
		order++
		out.Directives = append(out.Directives, Directive{Order: order, Section: section, Name: key, Values: []string{cleanValue(key, rest)}, Source: source, Line: line})
	}
	return out
}

func parseNginx(source, content string) Parsed {
	out := Parsed{Format: "nginx"}
	section := []string{}
	order := 0
	re := regexp.MustCompile(`(?s)([^{};]+)([{};])`)
	for _, m := range re.FindAllStringSubmatch(content, -1) {
		raw := strings.TrimSpace(stripComment(m[1]))
		token := m[2]
		if raw == "" {
			if token == "}" && len(section) > 0 {
				section = section[:len(section)-1]
			}
			continue
		}
		fields := strings.Fields(raw)
		if len(fields) == 0 {
			continue
		}
		name := strings.ToLower(fields[0])
		rest := strings.Join(fields[1:], " ")
		if token == "{" {
			section = append(section, strings.TrimSpace(name+" "+rest))
			continue
		}
		if token == "}" {
			if len(section) > 0 {
				section = section[:len(section)-1]
			}
			continue
		}
		if !allow["nginx"][name] {
			out.Unsupported = append(out.Unsupported, name)
			continue
		}
		order++
		out.Directives = append(out.Directives, Directive{Order: order, Section: strings.Join(section, "/"), Name: name, Values: []string{cleanValue(name, rest)}, Source: source})
	}
	return out
}

func parseHBA(source, content string) Parsed {
	out := Parsed{Format: "pg_hba"}
	s := bufio.NewScanner(strings.NewReader(content))
	order, line := 0, 0
	for s.Scan() {
		line++
		raw := strings.TrimSpace(stripComment(s.Text()))
		if raw == "" {
			continue
		}
		f := strings.Fields(raw)
		if len(f) < 4 {
			continue
		}
		// pg_hba rule order is behaviorally significant; all non-option fields are safe security metadata.
		order++
		vals := make([]string, len(f))
		copy(vals, f)
		for i := range vals {
			if pair := strings.SplitN(vals[i], "=", 2); len(pair) == 2 {
				vals[i] = pair[0] + "=" + sanitize.Value(pair[0], pair[1])
			}
		}
		out.Directives = append(out.Directives, Directive{Order: order, Name: "rule", Values: vals, Source: source, Line: line})
	}
	return out
}

func stripComment(s string) string {
	quoted := false
	for i, r := range s {
		if r == '\'' || r == '"' {
			quoted = !quoted
		}
		if r == '#' && !quoted {
			return s[:i]
		}
	}
	return s
}

func ParsePort(s string) int { n, _ := strconv.Atoi(s); return n }
