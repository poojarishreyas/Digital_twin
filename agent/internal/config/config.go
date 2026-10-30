package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	ServerAddress string              `yaml:"server_address"`
	AgentIDFile   string              `yaml:"agent_id_file"`
	StateDir      string              `yaml:"state_dir"`
	PollInterval  time.Duration       `yaml:"poll_interval"`
	FullInterval  time.Duration       `yaml:"full_snapshot_interval"`
	OutboxMax     int                 `yaml:"outbox_max_envelopes"`
	TLS           TLS                 `yaml:"tls"`
	ConfigFiles   map[string][]string `yaml:"config_files"`
}

type TLS struct {
	CA          string `yaml:"ca"`
	Certificate string `yaml:"certificate"`
	Key         string `yaml:"key"`
	ServerName  string `yaml:"server_name"`
}

func Load(path string) (Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return Config{}, err
	}
	if c.ServerAddress == "" {
		return Config{}, fmt.Errorf("server_address is required")
	}
	if c.StateDir == "" {
		if runtime.GOOS == "windows" {
			c.StateDir = filepath.Join(os.Getenv("ProgramData"), "TwinAgent")
		} else {
			c.StateDir = "/var/lib/twin-agent"
		}
	}
	if c.AgentIDFile == "" {
		c.AgentIDFile = filepath.Join(c.StateDir, "agent-id")
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 30 * time.Second
	}
	if c.FullInterval <= 0 {
		c.FullInterval = 6 * time.Hour
	}
	if c.OutboxMax <= 0 {
		c.OutboxMax = 1000
	}
	if c.TLS.CA == "" || c.TLS.Certificate == "" || c.TLS.Key == "" {
		return Config{}, fmt.Errorf("tls.ca, tls.certificate, and tls.key are required")
	}
	return c, nil
}
