package collector

import (
	"context"
	"os/exec"
	"strings"
)

func detectableVersions(ctx context.Context) map[string]string {
	commands := map[string]struct {
		binary string
		args   []string
	}{
		"nginx":      {"nginx", []string{"-v"}},
		"postgresql": {"postgres", []string{"--version"}},
		"redis":      {"redis-server", []string{"--version"}},
		"openssh":    {"ssh", []string{"-V"}},
	}
	out := map[string]string{}
	for service, spec := range commands {
		if _, err := exec.LookPath(spec.binary); err != nil {
			continue
		}
		if version, err := command(ctx, spec.binary, spec.args...); err == nil && version != "" {
			out[service] = firstLine(version)
		}
	}
	return out
}

func firstLine(value string) string {
	if i := strings.IndexByte(value, '\n'); i >= 0 {
		return strings.TrimSpace(value[:i])
	}
	return strings.TrimSpace(value)
}

func versionFor(service string, versions map[string]string) string {
	name := strings.ToLower(service)
	for key, value := range versions {
		if strings.Contains(name, key) || (key == "openssh" && (name == "ssh" || name == "sshd")) || (key == "postgresql" && strings.HasPrefix(name, "postgres")) || (key == "redis" && strings.HasPrefix(name, "redis")) {
			return value
		}
	}
	return ""
}
