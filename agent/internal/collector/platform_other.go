//go:build !linux && !windows

package collector

import (
	"context"
	"github.com/example/digital-twin/agent/internal/model"
	"os"
	"runtime"
	"time"
)

func collectHost(_ context.Context, id string, now time.Time) (model.Host, []model.Gap) {
	h, _ := os.Hostname()
	return model.Host{ID: id, Hostname: h, OS: runtime.GOOS, Architecture: runtime.GOARCH}, []model.Gap{gap("platform", "all", "unsupported", "only windows and linux are supported", now)}
}
func collectPlatform(_ context.Context, _ model.Host, _ time.Time) ([]model.Component, []model.Relationship, []model.Gap) {
	return nil, nil, nil
}
func processMetrics() (float64, uint64) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return 0, m.Sys
}
