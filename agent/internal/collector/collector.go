package collector

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/example/digital-twin/agent/internal/canonical"
	"github.com/example/digital-twin/agent/internal/model"
	"github.com/example/digital-twin/agent/internal/parsers"
)

type Result struct {
	Host          model.Host
	Components    []model.Component
	Relationships []model.Relationship
	Gaps          []model.Gap
	WatchedFiles  []string
}

type Collector struct {
	AgentID      string
	ConfigFiles  map[string][]string
	WorkloadFile string
}

func ProcessMetrics() (float64, uint64) { return processMetrics() }

func (c Collector) Collect(ctx context.Context) Result {
	now := time.Now().UTC()
	host, gaps := collectHost(ctx, c.AgentID, now)
	components, rels, platformGaps := collectPlatform(ctx, host, now)
	gaps = append(gaps, platformGaps...)
	if c.WorkloadFile != "" {
		wc, wr, wg := collectWorkload(c.WorkloadFile, host.ID, now)
		components = append(components, wc...)
		rels = append(rels, wr...)
		gaps = append(gaps, wg...)
	}

	paths := defaultConfigPaths()
	for service, configured := range c.ConfigFiles {
		if len(configured) > 0 {
			paths[service] = configured
		}
	}
	for service, candidates := range paths {
		found := false
		for _, path := range expandCandidates(candidates) {
			if _, err := os.Stat(path); err != nil {
				if !os.IsNotExist(err) {
					gaps = append(gaps, gap("config", service, "inaccessible", err.Error(), now))
				}
				continue
			}
			found = true
			parsed, err := parsers.ParseFile(service, path)
			if err != nil {
				gaps = append(gaps, gap("config", service, "parse_error", err.Error(), now))
				continue
			}
			data := map[string]any{"service": service, "path": filepath.Clean(path), "format": parsed.Format, "directives": parsed.Directives, "unsupported_directives": parsed.Unsupported}
			hash, _ := canonical.Hash(data)
			// Archetypes reflect ordered behaviorally relevant content, never the
			// host-specific file path, source filename, or line numbers.
			semantic := make([]map[string]any, 0, len(parsed.Directives))
			for _, directive := range parsed.Directives {
				semantic = append(semantic, map[string]any{
					"order": directive.Order, "section": directive.Section,
					"name": directive.Name, "values": directive.Values,
				})
			}
			archetypeHash, _ := canonical.Hash(map[string]any{
				"service": service, "directives": semantic,
				"unsupported_directives": parsed.Unsupported,
			})
			id := fmt.Sprintf("config:%s:%s", host.ID, strings.ToLower(filepath.Clean(path)))
			components = append(components, model.Component{Kind: "configuration", ID: id, Hash: hash, ArchetypeHash: archetypeHash, Data: data, Evidence: evidence("file:"+filepath.Clean(path), now)})
			rels = append(rels, model.Relationship{Kind: "HAS_CONFIGURATION", SourceID: host.ID, TargetID: id, Evidence: evidence("file:"+filepath.Clean(path), now)})
		}
		if !found {
			gaps = append(gaps, gap("config", service, "not_detected", "no configured path exists", now))
		}
	}
	sort.Slice(components, func(i, j int) bool { return components[i].ID < components[j].ID })
	sort.Slice(rels, func(i, j int) bool {
		if rels[i].SourceID == rels[j].SourceID {
			return rels[i].TargetID < rels[j].TargetID
		}
		return rels[i].SourceID < rels[j].SourceID
	})
	watched := existingPaths(paths)
	if c.WorkloadFile != "" {
		watched = append(watched, c.WorkloadFile)
	}
	return Result{Host: host, Components: components, Relationships: rels, Gaps: gaps, WatchedFiles: watched}
}

func defaultConfigPaths() map[string][]string {
	if runtime.GOOS == "windows" {
		return map[string][]string{
			"nginx":      {`C:\nginx\conf\nginx.conf`},
			"postgresql": {`C:\Program Files\PostgreSQL\*\data\postgresql.conf`},
			"pg_hba":     {`C:\Program Files\PostgreSQL\*\data\pg_hba.conf`},
			"redis":      {`C:\ProgramData\Redis\redis.conf`},
			"openssh":    {`C:\ProgramData\ssh\sshd_config`},
		}
	}
	return map[string][]string{
		"nginx":      {"/etc/nginx/nginx.conf"},
		"postgresql": {"/etc/postgresql/*/main/postgresql.conf", "/etc/postgresql/postgresql.conf", "/var/lib/pgsql/data/postgresql.conf"},
		"pg_hba":     {"/etc/postgresql/*/main/pg_hba.conf", "/etc/postgresql/pg_hba.conf", "/var/lib/pgsql/data/pg_hba.conf"},
		"redis":      {"/etc/redis/redis.conf", "/etc/redis.conf"},
		"openssh":    {"/etc/ssh/sshd_config"},
	}
}

func existingPaths(m map[string][]string) []string {
	var out []string
	for _, ps := range m {
		for _, p := range expandCandidates(ps) {
			if _, err := os.Stat(p); err == nil {
				out = append(out, p)
			}
		}
	}
	return out
}
func expandCandidates(paths []string) []string {
	var out []string
	for _, path := range paths {
		matches, err := filepath.Glob(path)
		if err == nil && len(matches) > 0 {
			out = append(out, matches...)
		} else if !strings.ContainsAny(path, "*?[") {
			out = append(out, path)
		}
	}
	return out
}
func evidence(source string, at time.Time) model.Evidence {
	return model.Evidence{Source: source, ObservedAt: at, Confidence: "observed"}
}
func gap(collector, field, reason, detail string, at time.Time) model.Gap {
	return model.Gap{Collector: collector, Field: field, Reason: reason, Detail: detail, At: at}
}
