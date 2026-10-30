"""Persistent security intent/outcome records. No request bodies or credentials."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS security_audit (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  stage text NOT NULL CHECK(stage IN ('intent','outcome','denied')),
  status integer,
  UNIQUE(request_id, stage)
);
-- Empty tenant: the request was refused before a tenant could be resolved.
ALTER TABLE security_audit ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS security_audit_time ON security_audit(recorded_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_tenant_time ON security_audit(tenant_id, recorded_at DESC);
"""


class AuditStore:
    def __init__(self, pool):
        self.pool = pool

    async def ensure_schema(self):
        await self.pool.execute(SCHEMA)

    async def record(self, request_id, actor, role, action, stage, status=None, tenant=""):
        await self.pool.execute(
            "INSERT INTO security_audit(request_id,actor,role,action,stage,status,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
            request_id, actor, role, action, stage, status, tenant)

    async def recent(self, tenant, limit=100):
        rows = await self.pool.fetch(
            "SELECT * FROM security_audit WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2", tenant, limit)
        return [dict(row) for row in rows]

    async def ready(self):
        await self.pool.fetchval("SELECT count(*) FROM (SELECT id FROM security_audit LIMIT 1) AS probe")
