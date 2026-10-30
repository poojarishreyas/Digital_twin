"""PostgreSQL queue and evidence store for isolated sandbox workers."""
from __future__ import annotations

import json
import os
from pathlib import Path
from jsonschema import Draft202012Validator
from uuid import uuid4
from datetime import datetime, timezone


SCHEMA = """
CREATE TABLE IF NOT EXISTS emulation_plans (
  id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), plan jsonb NOT NULL,
  services jsonb NOT NULL, graph_snapshot jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS emulation_runs (
  id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES emulation_plans(id),
  status text NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted')),
  worker_id text, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
  finished_at timestamptz, cleanup_status text NOT NULL DEFAULT 'pending',
  peak_cpu_millis integer NOT NULL DEFAULT 0, peak_ram_mb integer NOT NULL DEFAULT 0,
  error text
);
CREATE TABLE IF NOT EXISTS emulation_waves (
  run_id uuid NOT NULL REFERENCES emulation_runs(id), wave_index integer NOT NULL,
  status text NOT NULL, service_ids jsonb NOT NULL, path_ids jsonb NOT NULL,
  health jsonb NOT NULL DEFAULT '{}', started_at timestamptz, finished_at timestamptz,
  PRIMARY KEY(run_id,wave_index)
);
CREATE TABLE IF NOT EXISTS emulation_findings (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES emulation_runs(id),
  wave_index integer NOT NULL, target_id text NOT NULL, snapshot_hash text NOT NULL,
  image_id text NOT NULL, test_id text NOT NULL, test_version text NOT NULL,
  prerequisites jsonb NOT NULL, observations jsonb NOT NULL,
  verdict text NOT NULL CHECK(verdict IN ('confirmed','not_reproduced','inconclusive','unsupported')),
  fidelity_gaps jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emulation_runs_recent ON emulation_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS emulation_findings_run ON emulation_findings(run_id);
CREATE TABLE IF NOT EXISTS emulation_hunts (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES emulation_runs(id), wave_index integer NOT NULL,
  target_id text NOT NULL, data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
-- Plans and runs are owned by one tenant; waves, findings and hunts are reached
-- only through a tenant-checked run.
ALTER TABLE emulation_plans ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
ALTER TABLE emulation_runs ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS emulation_runs_tenant_recent ON emulation_runs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS emulation_runs_tenant_status ON emulation_runs(tenant_id, status);
"""

_bundled_schema = Path(__file__).resolve().parents[3] / "schema" / "finding-v1.schema.json"
_schema_path = Path(os.environ.get("TWIN_FINDING_SCHEMA_PATH", str(_bundled_schema if _bundled_schema.exists() else Path("/app/schema/finding-v1.schema.json"))))
FINDING_SCHEMA = json.loads(_schema_path.read_text(encoding="utf-8"))
FINDING_VALIDATOR = Draft202012Validator(FINDING_SCHEMA)


class RunStore:
    def __init__(self, pool):
        self.pool = pool

    async def ensure_schema(self):
        async with self.pool.acquire() as conn:
            await conn.execute(SCHEMA)

    @staticmethod
    def _decode(value):
        return json.loads(value) if isinstance(value, str) else value

    async def create_plan(self, tenant: str, plan: dict, services: list[dict], snapshot: dict) -> str:
        identifier = uuid4()
        await self.pool.execute("INSERT INTO emulation_plans(id,tenant_id,plan,services,graph_snapshot) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)",
                                identifier, tenant, json.dumps(plan), json.dumps(services), json.dumps(snapshot))
        return str(identifier)

    async def queue(self, tenant: str, plan_id: str, max_pending: int = 10, max_cpu: int = 2000, max_ram: int = 4096,
                    max_tenant_pending: int = 3) -> str:
        from uuid import UUID
        identifier, parsed = uuid4(), UUID(plan_id)
        async with self.pool.acquire() as conn, conn.transaction():
            # Serialize admission across API requests/processes; workers only reduce this count.
            await conn.execute("SELECT pg_advisory_xact_lock(749312801)")
            if await conn.fetchval("SELECT count(*) FROM emulation_runs WHERE status IN ('queued','running')") >= max_pending:
                raise ValueError("run queue capacity reached")
            if await conn.fetchval("SELECT count(*) FROM emulation_runs WHERE tenant_id=$1 AND status IN ('queued','running')",
                                   tenant) >= max_tenant_pending:
                raise ValueError("tenant run queue capacity reached")
            # A plan ID from another tenant is indistinguishable from a missing one.
            plan_row = await conn.fetchrow("SELECT plan FROM emulation_plans WHERE id=$1 AND tenant_id=$2", parsed, tenant)
            if plan_row is None:
                raise KeyError(plan_id)
            plan = self._decode(plan_row["plan"])
            budget = plan.get("budget", {})
            if any(type(budget.get(key)) is not int or not 1 <= budget[key] <= maximum
                   for key, maximum in (("cpu_millis", max_cpu), ("ram_mb", max_ram))):
                raise ValueError("stored plan exceeds current server budget or requires regeneration")
            if not plan["waves"]:
                raise ValueError("plan has no emulatable waves")
            await conn.execute("INSERT INTO emulation_runs(id,tenant_id,plan_id,status) VALUES($1,$2,$3,'queued')",
                               identifier, tenant, parsed)
        return str(identifier)

    async def claim(self, worker_id: str) -> dict | None:
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow("""SELECT r.id,r.tenant_id,p.plan,p.services,p.graph_snapshot FROM emulation_runs r
              JOIN emulation_plans p ON p.id=r.plan_id AND p.tenant_id=r.tenant_id WHERE r.status='queued'
              ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1""")
            if not row:
                return None
            await conn.execute("UPDATE emulation_runs SET status='running',worker_id=$2,started_at=now() WHERE id=$1", row["id"], worker_id)
            result = dict(row)
            for field in ("plan", "services", "graph_snapshot"):
                result[field] = self._decode(result[field])
            return result

    async def update_run(self, run_id, status: str, cleanup_status: str, error: str = "", peak_cpu: int = 0, peak_ram: int = 0):
        await self.pool.execute("""UPDATE emulation_runs SET status=$2,cleanup_status=$3,error=$4,
          peak_cpu_millis=$5,peak_ram_mb=$6,finished_at=now() WHERE id=$1""",
          run_id, status, cleanup_status, error[:1000], peak_cpu, peak_ram)

    async def wave(self, run_id, index: int, status: str, service_ids: list[str], path_ids: list[str], health: dict):
        await self.pool.execute("""INSERT INTO emulation_waves(run_id,wave_index,status,service_ids,path_ids,health,started_at)
          VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,now()) ON CONFLICT(run_id,wave_index) DO UPDATE
          SET status=$3,health=$6::jsonb,finished_at=CASE WHEN $3 IN ('completed','failed','unsupported') THEN now() ELSE NULL END""",
          run_id, index, status, json.dumps(service_ids), json.dumps(path_ids), json.dumps(health))

    async def finding(self, run_id, wave_index: int, finding: dict):
        FINDING_VALIDATOR.validate(finding)
        await self.pool.execute("""INSERT INTO emulation_findings
          (id,run_id,wave_index,target_id,snapshot_hash,image_id,test_id,test_version,prerequisites,observations,verdict,fidelity_gaps)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb)""",
          uuid4(), run_id, wave_index, finding["target_id"], finding["snapshot_hash"], finding["image_id"],
          finding["test_id"], finding["test_version"], json.dumps(finding["prerequisites"]),
          json.dumps(finding["observations"]), finding["verdict"], json.dumps(finding["fidelity_gaps"]))

    async def recent(self, tenant: str, limit: int = 50) -> list[dict]:
        rows = await self.pool.fetch("SELECT * FROM emulation_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2",
                                     tenant, min(limit, 100))
        return [dict(row) for row in rows]

    async def record_hunt(self, run_id, wave_index, target_id, result):
        await self.pool.execute("INSERT INTO emulation_hunts(id,run_id,wave_index,target_id,data) VALUES($1,$2,$3,$4,$5::jsonb)",
                                uuid4(), run_id, wave_index, target_id, json.dumps(result))

    async def detail(self, tenant: str, run_id: str) -> dict | None:
        from uuid import UUID
        identifier = UUID(run_id)
        run = await self.pool.fetchrow("""SELECT r.*,p.plan,p.services FROM emulation_runs r
          JOIN emulation_plans p ON p.id=r.plan_id AND p.tenant_id=r.tenant_id WHERE r.id=$1 AND r.tenant_id=$2""",
          identifier, tenant)
        if not run:
            return None
        waves = await self.pool.fetch("SELECT * FROM emulation_waves WHERE run_id=$1 ORDER BY wave_index", identifier)
        findings = await self.pool.fetch("SELECT * FROM emulation_findings WHERE run_id=$1 ORDER BY recorded_at", identifier)
        hunts = await self.pool.fetch("SELECT * FROM emulation_hunts WHERE run_id=$1 ORDER BY recorded_at", identifier)
        run_data = dict(run)
        run_data["plan"] = self._decode(run_data["plan"])
        run_data["services"] = self._decode(run_data["services"])
        wave_data = []
        for row in waves:
            item = dict(row)
            for field in ("service_ids", "path_ids", "health"):
                item[field] = self._decode(item[field])
            wave_data.append(item)
        finding_data = []
        for row in findings:
            item = dict(row)
            for field in ("prerequisites", "observations", "fidelity_gaps"):
                item[field] = self._decode(item[field])
            finding_data.append(item)
        universe = {path["id"] for path in run_data["plan"]["paths"]}
        validated = {item["observations"]["path_id"] for item in finding_data
                     if item["test_id"] == "scenario.http_chain" and item["verdict"] == "confirmed"
                     and "path_id" in item["observations"]}
        hunt_data = [{**dict(h), "data": self._decode(h["data"])} for h in hunts]
        return {"run": run_data, "waves": wave_data, "findings": finding_data, "hunts": hunt_data,
                "validated_path_ids": sorted(validated & universe),
                "unvalidated_path_ids": sorted(universe - validated)}

    async def interrupt_stale(self, worker_id: str):
        # The worker reconciles all labeled Docker resources before claiming work.
        await self.pool.execute("UPDATE emulation_runs SET status='interrupted',cleanup_status='reconciled',finished_at=now() WHERE status='running' AND worker_id=$1", worker_id)

