-- Every row is owned by exactly one tenant. Keys include tenant_id so that an
-- agent identity or sequence can never collide with, or overwrite, another tenant.
CREATE TABLE IF NOT EXISTS ingestion_receipts (
  tenant_id text NOT NULL DEFAULT 'default',
  agent_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NOT NULL,
  applied_at timestamptz,
  full_snapshot boolean NOT NULL,
  peer_identity text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','applied','failed')),
  error text,
  PRIMARY KEY (tenant_id, agent_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_state (
  tenant_id text NOT NULL DEFAULT 'default',
  agent_id text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0,
  last_seen timestamptz NOT NULL,
  needs_full boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, agent_id)
);

CREATE TABLE IF NOT EXISTS collection_metrics (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'default',
  agent_id text NOT NULL,
  sequence bigint NOT NULL,
  recorded_at timestamptz NOT NULL,
  collection_ms bigint NOT NULL,
  cpu_percent double precision NOT NULL,
  ram_bytes bigint NOT NULL,
  bytes_received bigint NOT NULL,
  event_to_collect_ms bigint NOT NULL,
  event_to_graph_ms bigint NOT NULL,
  polling_interval_sec integer NOT NULL,
  hardware jsonb NOT NULL,
  UNIQUE (tenant_id, agent_id, sequence)
);

CREATE TABLE IF NOT EXISTS collection_gaps (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'default',
  agent_id text NOT NULL,
  collector text NOT NULL,
  field text NOT NULL,
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS collection_metrics_tenant_time ON collection_metrics(tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS collection_gaps_tenant_agent ON collection_gaps(tenant_id, agent_id);
