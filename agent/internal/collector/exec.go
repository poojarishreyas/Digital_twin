package collector

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func command(ctx context.Context, name string, args ...string) (string, error) {
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	b, err := exec.CommandContext(c, name, args...).CombinedOutput()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}
