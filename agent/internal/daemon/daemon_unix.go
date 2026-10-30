//go:build !windows

package daemon

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func Run(_ string, fn func(context.Context) error) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return fn(ctx)
}
