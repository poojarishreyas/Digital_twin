"""Tenant-scoped immutable deployment artifacts and connected-application jobs."""
import json
from uuid import UUID, uuid4

from .contracts import Artifact


def decoded(value):
    return json.loads(value) if isinstance(value, str) else value


class CompanyStore:
    def __init__(self, pool):
        self.pool = pool

    async def ensure_schema(self):
        await self.pool.execute("""CREATE TABLE IF NOT EXISTS company_artifacts(
          tenant_id text NOT NULL,id text NOT NULL,data jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id));
          CREATE TABLE IF NOT EXISTS company_runs(
          tenant_id text NOT NULL,id uuid NOT NULL,artifact_id text NOT NULL,
          status text NOT NULL DEFAULT 'queued',discovery jsonb NOT NULL,result jsonb,
          error text,worker_id text,created_at timestamptz NOT NULL DEFAULT now(),
          started_at timestamptz,finished_at timestamptz,PRIMARY KEY(tenant_id,id),
          FOREIGN KEY(tenant_id,artifact_id) REFERENCES company_artifacts(tenant_id,id));
          CREATE INDEX IF NOT EXISTS company_runs_recent ON company_runs(tenant_id,created_at DESC);""")

    async def put_artifact(self, tenant, artifact: Artifact):
        await self.pool.execute("""INSERT INTO company_artifacts(tenant_id,id,data) VALUES($1,$2,$3::jsonb)
            ON CONFLICT(tenant_id,id) DO NOTHING""", tenant, artifact.artifact_id, artifact.model_dump_json())
        return artifact.artifact_id

    async def artifacts(self, tenant):
        rows = await self.pool.fetch("SELECT id,data,created_at FROM company_artifacts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100", tenant)
        return [{"id": row["id"], "artifact": decoded(row["data"]), "created_at": row["created_at"]} for row in rows]

    async def artifact(self, tenant, artifact_id):
        value = await self.pool.fetchval("SELECT data FROM company_artifacts WHERE tenant_id=$1 AND id=$2", tenant, artifact_id)
        return Artifact.model_validate(decoded(value)) if value else None

    async def queue(self, tenant, artifact_id, discovery, global_limit=10, tenant_limit=3):
        run_id = uuid4()
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(73619205)")
            counts = await conn.fetchrow("""SELECT count(*) AS total,
                count(*) FILTER(WHERE tenant_id=$1) AS own FROM company_runs WHERE status IN ('queued','running')""", tenant)
            if counts["total"] >= global_limit or counts["own"] >= tenant_limit:
                raise ValueError("company job capacity exceeded")
            await conn.execute("INSERT INTO company_runs(tenant_id,id,artifact_id,discovery) VALUES($1,$2,$3,$4::jsonb)",
                               tenant, run_id, artifact_id, json.dumps(discovery))
        return str(run_id)

    async def claim(self, worker_id):
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow("""SELECT * FROM company_runs WHERE status='queued'
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1""")
            if row is None:
                return None
            await conn.execute("UPDATE company_runs SET status='running',worker_id=$3,started_at=now() WHERE tenant_id=$1 AND id=$2",
                               row["tenant_id"], row["id"], worker_id)
        return {**dict(row), "discovery": decoded(row["discovery"])}

    async def finish(self, tenant, run_id, result=None, error=None):
        status = result.get("status", "failed") if result else "failed"
        await self.pool.execute("""UPDATE company_runs SET status=$3,result=$4::jsonb,error=$5,finished_at=now()
            WHERE tenant_id=$1 AND id=$2 AND status='running'""", tenant, UUID(str(run_id)), status,
            json.dumps(result) if result else None, error)

    async def recent(self, tenant):
        rows = await self.pool.fetch("""SELECT id,artifact_id,status,created_at,started_at,finished_at,error
            FROM company_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100""", tenant)
        return [dict(row) for row in rows]

    async def get(self, tenant, run_id):
        row = await self.pool.fetchrow("SELECT * FROM company_runs WHERE tenant_id=$1 AND id=$2", tenant, UUID(run_id))
        if not row:
            return None
        value = dict(row)
        for key in ("discovery", "result"):
            value[key] = decoded(value[key])
        return value
