from dataclasses import dataclass
from datetime import datetime, timezone
import json
import asyncpg
from .models import Envelope

# Upgrades a single-company database in place: existing rows join the
# 'default' tenant and keys are widened to include tenant_id. Idempotent.
MIGRATION = """
ALTER TABLE ingestion_receipts ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE agent_state ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE collection_metrics ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE collection_gaps ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
DO $$
DECLARE tbl text; cols text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ingestion_receipts', 'agent_state'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = tbl::regclass AND i.indisprimary AND a.attname = 'tenant_id'
    ) THEN
      cols := CASE tbl WHEN 'agent_state' THEN 'tenant_id, agent_id' ELSE 'tenant_id, agent_id, sequence' END;
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I, ADD PRIMARY KEY (%s)', tbl, tbl || '_pkey', cols);
    END IF;
  END LOOP;
END $$;
ALTER TABLE collection_metrics DROP CONSTRAINT IF EXISTS collection_metrics_agent_id_sequence_key;
CREATE UNIQUE INDEX IF NOT EXISTS collection_metrics_tenant_id_agent_id_sequence_key
  ON collection_metrics(tenant_id, agent_id, sequence);
CREATE INDEX IF NOT EXISTS collection_metrics_tenant_time ON collection_metrics(tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS collection_gaps_tenant_agent ON collection_gaps(tenant_id, agent_id);
"""


@dataclass
class Reservation:
    duplicate: bool
    require_full: bool


class HistoryStore:
    """Ingestion history. Every query is constrained to one tenant."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.pool: asyncpg.Pool | None = None

    async def open(self):
        self.pool = await asyncpg.create_pool(self.database_url, min_size=1, max_size=10)

    async def ensure_schema(self):
        assert self.pool
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute(MIGRATION)

    async def close(self):
        if self.pool:
            await self.pool.close()

    async def reserve(self, tenant: str, envelope: Envelope, peer_identity: str) -> Reservation:
        assert self.pool
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                "SELECT last_sequence, needs_full FROM agent_state WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE",
                tenant, envelope.agent_id,
            )
            receipt = await conn.fetchrow(
                "SELECT status FROM ingestion_receipts WHERE tenant_id=$1 AND agent_id=$2 AND sequence=$3",
                tenant, envelope.agent_id, envelope.sequence,
            )
            if receipt and receipt["status"] == "applied":
                await conn.execute("UPDATE agent_state SET last_seen=now() WHERE tenant_id=$1 AND agent_id=$2",
                                   tenant, envelope.agent_id)
                return Reservation(True, bool(row and row["needs_full"]))

            last = int(row["last_sequence"]) if row else 0
            needs_full = bool(row["needs_full"]) if row else True
            if envelope.sequence > last + 1:
                needs_full = True
            if envelope.full_snapshot:
                needs_full = False
            if envelope.sequence <= last:
                return Reservation(True, needs_full)

            await conn.execute(
                """INSERT INTO ingestion_receipts(tenant_id,agent_id,sequence,sent_at,full_snapshot,peer_identity,status)
                   VALUES($1,$2,$3,$4,$5,$6,'processing')
                   ON CONFLICT(tenant_id,agent_id,sequence) DO UPDATE SET status='processing', error=NULL, received_at=now()""",
                tenant, envelope.agent_id, envelope.sequence, envelope.sent_at, envelope.full_snapshot, peer_identity,
            )
            await conn.execute(
                """INSERT INTO agent_state(tenant_id,agent_id,last_sequence,last_seen,needs_full)
                   VALUES($1,$2,$3,now(),$4)
                   ON CONFLICT(tenant_id,agent_id) DO UPDATE SET last_seen=now(), needs_full=$4""",
                tenant, envelope.agent_id, last, needs_full,
            )
            return Reservation(False, needs_full)

    async def applied(self, tenant: str, envelope: Envelope, event_to_graph_ms: int, bytes_received: int):
        assert self.pool
        m = envelope.metrics
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "UPDATE ingestion_receipts SET status='applied', applied_at=now() WHERE tenant_id=$1 AND agent_id=$2 AND sequence=$3",
                tenant, envelope.agent_id, envelope.sequence,
            )
            await conn.execute(
                """UPDATE agent_state SET last_sequence=GREATEST(last_sequence,$3), last_seen=now(),
                   needs_full=CASE WHEN $4 THEN false ELSE needs_full END WHERE tenant_id=$1 AND agent_id=$2""",
                tenant, envelope.agent_id, envelope.sequence, envelope.full_snapshot,
            )
            await conn.execute(
                """INSERT INTO collection_metrics(tenant_id,agent_id,sequence,recorded_at,collection_ms,cpu_percent,ram_bytes,
                   bytes_received,event_to_collect_ms,event_to_graph_ms,polling_interval_sec,hardware)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)""",
                tenant, envelope.agent_id, envelope.sequence, datetime.now(timezone.utc), m.collection_ms, m.cpu_percent,
                m.ram_bytes, bytes_received, m.event_to_collect_ms, event_to_graph_ms, m.polling_interval_sec,
                json.dumps(envelope.host.hardware),
            )
            await conn.execute("DELETE FROM collection_gaps WHERE tenant_id=$1 AND agent_id=$2", tenant, envelope.agent_id)
            if envelope.gaps:
                await conn.executemany(
                    """INSERT INTO collection_gaps(tenant_id,agent_id,collector,field,reason,detail,observed_at)
                       VALUES($1,$2,$3,$4,$5,$6,$7)""",
                    [(tenant, envelope.agent_id, g.collector, g.field, g.reason, g.detail, g.at) for g in envelope.gaps],
                )

    async def failed(self, tenant: str, envelope: Envelope, error: str):
        assert self.pool
        async with self.pool.acquire() as conn:
            await conn.execute(
                "UPDATE ingestion_receipts SET status='failed', error=$4 WHERE tenant_id=$1 AND agent_id=$2 AND sequence=$3",
                tenant, envelope.agent_id, envelope.sequence, error[:1000],
            )

    async def inventory(self, tenant: str, stale_after_seconds: int) -> list[dict]:
        assert self.pool
        rows = await self.pool.fetch(
            """SELECT s.agent_id,s.last_sequence,s.last_seen,s.needs_full,
               EXTRACT(EPOCH FROM (now()-s.last_seen)) > $2 AS stale,
               COALESCE(json_agg(json_build_object('collector',g.collector,'field',g.field,'reason',g.reason,'detail',g.detail))
                 FILTER (WHERE g.agent_id IS NOT NULL),'[]') AS gaps
               FROM agent_state s LEFT JOIN collection_gaps g ON g.tenant_id=s.tenant_id AND g.agent_id=s.agent_id
               WHERE s.tenant_id=$1
               GROUP BY s.agent_id,s.last_sequence,s.last_seen,s.needs_full ORDER BY s.agent_id""",
            tenant, stale_after_seconds,
        )
        return [dict(r) for r in rows]

    async def metrics(self, tenant: str, limit: int = 200) -> list[dict]:
        assert self.pool
        rows = await self.pool.fetch(
            "SELECT * FROM collection_metrics WHERE tenant_id=$1 ORDER BY recorded_at DESC LIMIT $2", tenant, min(limit, 1000))
        return [dict(r) for r in rows]
