package model

import (
	"encoding/json"
	"time"
)

const SchemaVersion = "1.0"

type Evidence struct {
	Source     string    `json:"source"`
	ObservedAt time.Time `json:"observed_at"`
	Confidence string    `json:"confidence"`
}

type Gap struct {
	Collector string    `json:"collector"`
	Field     string    `json:"field"`
	Reason    string    `json:"reason"`
	Detail    string    `json:"detail,omitempty"`
	At        time.Time `json:"at"`
}

type Host struct {
	ID           string            `json:"id"`
	Hostname     string            `json:"hostname"`
	OS           string            `json:"os"`
	OSVersion    string            `json:"os_version,omitempty"`
	Architecture string            `json:"architecture"`
	Kernel       string            `json:"kernel,omitempty"`
	Hardware     map[string]string `json:"hardware,omitempty"`
}

type Component struct {
	Kind          string         `json:"kind"`
	ID            string         `json:"id"`
	Hash          string         `json:"hash"`
	ArchetypeHash string         `json:"archetype_hash,omitempty"`
	Data          map[string]any `json:"data"`
	Evidence      Evidence       `json:"evidence"`
}

type Relationship struct {
	Kind       string         `json:"kind"`
	SourceID   string         `json:"source_id"`
	TargetID   string         `json:"target_id"`
	Properties map[string]any `json:"properties,omitempty"`
	Evidence   Evidence       `json:"evidence"`
}

type Metrics struct {
	CollectionMS       int64   `json:"collection_ms"`
	CPUPercent         float64 `json:"cpu_percent"`
	RAMBytes           uint64  `json:"ram_bytes"`
	EnvelopeBytes      int     `json:"envelope_bytes"`
	PollingIntervalSec int     `json:"polling_interval_sec"`
	TriggeredAt        string  `json:"triggered_at,omitempty"`
	EventToCollectMS   int64   `json:"event_to_collect_ms,omitempty"`
}

type Envelope struct {
	SchemaVersion string         `json:"schema_version"`
	AgentID       string         `json:"agent_id"`
	Sequence      uint64         `json:"sequence"`
	SentAt        time.Time      `json:"sent_at"`
	FullSnapshot  bool           `json:"full_snapshot"`
	Host          Host           `json:"host"`
	Components    []Component    `json:"components"`
	Removed       []string       `json:"removed,omitempty"`
	Relationships []Relationship `json:"relationships"`
	Gaps          []Gap          `json:"gaps"`
	Metrics       Metrics        `json:"metrics"`
}

type Ack struct {
	AcceptedSequence uint64 `json:"accepted_sequence"`
	Duplicate        bool   `json:"duplicate"`
	RequireFull      bool   `json:"require_full_snapshot"`
	Error            string `json:"error,omitempty"`
}

// MarshalJSON keeps required telemetry collections as arrays on empty deltas.
// A null collection is rejected by the server schema and would block the outbox.
func (e Envelope) MarshalJSON() ([]byte, error) {
	type wire Envelope
	value := wire(e)
	if value.Components == nil {
		value.Components = []Component{}
	}
	if value.Relationships == nil {
		value.Relationships = []Relationship{}
	}
	if value.Gaps == nil {
		value.Gaps = []Gap{}
	}
	return json.Marshal(value)
}
