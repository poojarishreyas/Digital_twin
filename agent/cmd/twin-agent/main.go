package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/example/digital-twin/agent/internal/collector"
	"github.com/example/digital-twin/agent/internal/config"
	"github.com/example/digital-twin/agent/internal/daemon"
	"github.com/example/digital-twin/agent/internal/enroll"
	"github.com/example/digital-twin/agent/internal/model"
	"github.com/example/digital-twin/agent/internal/syncer"
	"github.com/fsnotify/fsnotify"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "enroll" {
		runEnroll(os.Args[2:])
		return
	}
	configPath := flag.String("config", "config.yaml", "agent configuration")
	once := flag.Bool("once", false, "collect and attempt one synchronization")
	flag.Parse()
	cfg, err := config.Load(*configPath)
	if err != nil {
		fatal("load configuration", err)
	}
	if err = os.MkdirAll(cfg.StateDir, 0700); err != nil {
		fatal("create state directory", err)
	}
	agentID, err := loadOrCreateID(cfg.AgentIDFile, cfg.TLS.Certificate)
	if err != nil {
		fatal("load identity", err)
	}
	outbox, err := syncer.NewOutbox(cfg.StateDir, cfg.OutboxMax)
	if err != nil {
		fatal("open outbox", err)
	}
	client, err := syncer.NewClient(cfg)
	if err != nil {
		fatal("configure transport", err)
	}
	a := &app{cfg: cfg, collector: collector.Collector{AgentID: agentID, ConfigFiles: cfg.ConfigFiles, WorkloadFile: cfg.WorkloadFile}, outbox: outbox, client: client, log: slog.New(slog.NewJSONHandler(os.Stdout, nil))}
	if err = daemon.Run("TwinAgent", func(ctx context.Context) error { return a.run(ctx, *once) }); err != nil {
		fatal("agent stopped", err)
	}
}

type app struct {
	cfg          config.Config
	collector    collector.Collector
	outbox       *syncer.Outbox
	client       *syncer.Client
	log          *slog.Logger
	last         map[string]string
	forceFull    bool
	lastFull     time.Time
	sequence     uint64
	watchedFiles []string
}

func (a *app) run(ctx context.Context, once bool) error {
	seq, err := syncer.LoadSequence(a.cfg.StateDir)
	if err != nil {
		return err
	}
	a.sequence = seq
	a.forceFull = true
	if err = a.collectQueue(ctx, "startup", time.Now()); err != nil {
		return err
	}
	a.flush(ctx)
	if once {
		return nil
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()
	a.addWatches(w)
	ticker := time.NewTicker(a.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			a.flush(context.Background())
			return nil
		case ev := <-w.Events:
			if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0 {
				started := time.Now()
				time.Sleep(200 * time.Millisecond)
				_ = a.collectQueue(ctx, "file_event", started)
				a.flush(ctx)
				a.addWatches(w)
			}
		case err := <-w.Errors:
			a.log.Warn("file watcher error", "error", err.Error())
		case now := <-ticker.C:
			_ = a.collectQueue(ctx, "poll", now)
			a.flush(ctx)
		}
	}
}

func (a *app) addWatches(w *fsnotify.Watcher) {
	seen := map[string]bool{}
	for _, p := range a.watchedFiles {
		dir := filepath.Dir(p)
		if !seen[dir] {
			_ = w.Add(dir)
			seen[dir] = true
		}
	}
	for _, paths := range a.cfg.ConfigFiles {
		for _, p := range paths {
			dir := filepath.Dir(p)
			if !seen[dir] {
				_ = w.Add(dir)
				seen[dir] = true
			}
		}
	}
}

func (a *app) collectQueue(ctx context.Context, trigger string, triggered time.Time) error {
	start := time.Now()
	result := a.collector.Collect(ctx)
	full := a.forceFull || time.Since(a.lastFull) >= a.cfg.FullInterval || a.last == nil
	a.watchedFiles = result.WatchedFiles
	current := map[string]string{}
	var changed []model.Component
	for _, c := range result.Components {
		current[c.ID] = c.Hash
		if full || a.last[c.ID] != c.Hash {
			changed = append(changed, c)
		}
	}
	var removed []string
	if !full {
		for id := range a.last {
			if _, ok := current[id]; !ok {
				removed = append(removed, id)
			}
		}
	}
	sort.Strings(removed)
	if !full && len(changed) == 0 && len(removed) == 0 && trigger != "poll" {
		return nil
	}
	a.sequence++
	cpu, ram := collector.ProcessMetrics()
	env := model.Envelope{SchemaVersion: model.SchemaVersion, AgentID: result.Host.ID, Sequence: a.sequence, SentAt: time.Now().UTC(), FullSnapshot: full, Host: result.Host, Components: changed, Removed: removed, Relationships: result.Relationships, Gaps: result.Gaps, Metrics: model.Metrics{CollectionMS: time.Since(start).Milliseconds(), CPUPercent: cpu, RAMBytes: ram, PollingIntervalSec: int(a.cfg.PollInterval.Seconds()), TriggeredAt: trigger, EventToCollectMS: time.Since(triggered).Milliseconds()}}
	b, _ := json.Marshal(env)
	env.Metrics.EnvelopeBytes = len(b)
	dropped, err := a.outbox.Put(env)
	if err != nil {
		return err
	}
	if dropped {
		a.forceFull = true
		a.log.Warn("outbox capacity exceeded; oldest envelope dropped; full reconciliation required")
	}
	if err = syncer.SaveSequence(a.cfg.StateDir, a.sequence); err != nil {
		return err
	}
	a.last = current
	if full {
		a.lastFull = time.Now()
		a.forceFull = false
	}
	return nil
}

func (a *app) flush(ctx context.Context) {
	pending, err := a.outbox.Pending()
	if err != nil {
		a.log.Error("read outbox", "error", err.Error())
		return
	}
	for _, e := range pending {
		ack, err := a.client.Send(ctx, e)
		if err != nil {
			a.log.Warn("synchronization deferred", "sequence", e.Sequence, "error", err.Error())
			return
		}
		if ack.Error != "" {
			a.log.Error("ingestion rejected envelope", "sequence", e.Sequence, "error", ack.Error)
			return
		}
		if err = a.outbox.Ack(e.Sequence); err != nil {
			a.log.Warn("remove acknowledged envelope", "error", err.Error())
			return
		}
		if ack.RequireFull {
			a.forceFull = true
		}
		a.log.Info("synchronized", "sequence", e.Sequence, "duplicate", ack.Duplicate)
	}
}

func loadOrCreateID(path, certificatePath string) (string, error) {
	certPEM, err := os.ReadFile(certificatePath)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", fmt.Errorf("client certificate PEM is invalid")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(cert.Subject.CommonName)
	if len(id) < 16 || len(id) > 128 {
		return "", fmt.Errorf("client certificate common name must be an agent ID (16-128 characters)")
	}
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		if strings.TrimSpace(string(b)) != id {
			return "", fmt.Errorf("stored agent identity does not match client certificate")
		}
		return id, nil
	} else if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(id), 0600); err != nil {
		return "", err
	}
	return id, os.Rename(tmp, path)
}

// runEnroll exchanges a dashboard enrollment token for this machine's identity and config.
func runEnroll(args []string) {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	platform := fs.String("url", "", "platform URL, for example https://twin.example.com")
	token := fs.String("token", "", "enrollment token from the dashboard (dtk_...)")
	dir := fs.String("dir", defaultConfigDir(), "directory for the key, certificates and config.yaml")
	allowHTTP := fs.Bool("allow-http", false, "permit plain HTTP to the platform (isolated labs only)")
	force := fs.Bool("force", false, "replace an existing identity in -dir")
	_ = fs.Parse(args)
	if *token == "" {
		*token = os.Getenv("TWIN_ENROLL_TOKEN") // Keeps the token out of process listings when preferred.
	}
	id, cfgPath, err := enroll.Run(enroll.Options{URL: *platform, Token: *token, Dir: *dir, AllowHTTP: *allowHTTP, Force: *force})
	if err != nil {
		fatal("enroll", err)
	}
	fmt.Printf("Enrolled as agent %s\nConfiguration written to %s\n", id, cfgPath)
}

func defaultConfigDir() string {
	if pd := os.Getenv("ProgramData"); pd != "" {
		return filepath.Join(pd, "TwinAgent", "config")
	}
	return "/etc/twin-agent"
}

func fatal(msg string, err error) { fmt.Fprintln(os.Stderr, msg+":", err); os.Exit(1) }
