import json
from uuid import UUID
from .contracts import Report


class ResearchStore:
    def __init__(self, pool):
        self.pool = pool

    async def ensure_schema(self):
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("""CREATE TABLE IF NOT EXISTS research_reports (
                tenant_id text NOT NULL DEFAULT 'default', id uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(), manifest_hash text NOT NULL,
                data jsonb NOT NULL, PRIMARY KEY (tenant_id, id))""")
            # Upgrade a single-company table: the same run ID may exist once per tenant.
            await conn.execute("""ALTER TABLE research_reports ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
                                 WHERE i.indrelid='research_reports'::regclass AND i.indisprimary AND a.attname='tenant_id') THEN
                    ALTER TABLE research_reports DROP CONSTRAINT research_reports_pkey, ADD PRIMARY KEY (tenant_id, id);
                  END IF;
                END $$;
                CREATE INDEX IF NOT EXISTS research_reports_tenant_recent ON research_reports(tenant_id, created_at DESC)""")

    async def put(self, tenant: str, report: Report):
        # Immutable run IDs: repeating the identical upload is idempotent;
        # changing a published run requires a new run ID.
        data = report.model_dump_json()
        await self.pool.execute("""INSERT INTO research_reports(tenant_id,id,manifest_hash,data) VALUES($1,$2,$3,$4::jsonb)
                                   ON CONFLICT(tenant_id,id) DO NOTHING""",
                                tenant, UUID(report.run_id), report.manifest_hash, data)
        current = await self.pool.fetchval("SELECT data FROM research_reports WHERE tenant_id=$1 AND id=$2",
                                           tenant, UUID(report.run_id))
        decoded = json.loads(current) if isinstance(current, str) else current
        if decoded != json.loads(data):
            raise ValueError("run ID already contains different results")

    async def recent(self, tenant: str):
        rows = await self.pool.fetch("""SELECT id,created_at,manifest_hash,data->>'mode' AS mode FROM research_reports
                                        WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100""", tenant)
        return [dict(row) for row in rows]

    async def get(self, tenant: str, run_id):
        value = await self.pool.fetchval("SELECT data FROM research_reports WHERE tenant_id=$1 AND id=$2", tenant, UUID(run_id))
        return json.loads(value) if isinstance(value, str) else value
