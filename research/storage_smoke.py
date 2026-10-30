"""Real PostgreSQL schema and immutable-report integration test; disposable database."""
import asyncio
import copy
import json
import time
from pathlib import Path
from uuid import UUID
import asyncpg
import docker
from twin_ingestion.phase2.adapters import CATALOG
from twin_ingestion.phase2.store import RunStore
from twin_ingestion.phase3.contracts import Report
from twin_ingestion.phase3.store import ResearchStore


async def verify(port):
    pool = await asyncpg.create_pool(host="127.0.0.1", port=port, user="synthetic",
        password="lab-only-password", database="synthetic", min_size=1, max_size=3)
    try:
        research, runs = ResearchStore(pool), RunStore(pool)
        await research.ensure_schema()
        await runs.ensure_schema()
        report = Report.model_validate_json(Path("research/results/repeated/report.json").read_text())
        await asyncio.gather(*(research.put("smoke", report) for _ in range(3)))
        assert await pool.fetchval("SELECT count(*) FROM research_reports") == 1
        assert (await research.get("smoke", report.run_id))["rows"] == report.rows
        assert await research.get("smoke-other", report.run_id) is None  # Tenant isolation.
        changed = copy.deepcopy(report)
        changed.limitations.append("different results cannot overwrite a run")
        try:
            await research.put("smoke", changed)
        except ValueError:
            pass
        else:
            raise AssertionError("changed report overwrote immutable run")
        plan_id = await runs.create_plan("smoke", {"waves": [{"index": 0}], "paths": [],
                                                   "budget": {"cpu_millis": 100, "ram_mb": 100}}, [], {})
        try:
            await runs.queue("smoke-other", plan_id)
        except KeyError:
            pass
        else:
            raise AssertionError("another tenant queued this tenant's plan")
        run_id = await runs.queue("smoke", plan_id)
        await runs.record_hunt(UUID(run_id), 0, "synthetic", {"status": "test", "trace": []})
        detail = await runs.detail("smoke", run_id)
        assert len(detail["hunts"]) == 1
        assert await runs.detail("smoke-other", run_id) is None
        result = {"real_postgresql": True, "report_roundtrip_rows": len(report.rows),
                  "concurrent_identical_imports": 3, "stored_reports": 1,
                  "changed_duplicate_rejected": True, "attached_hunt_roundtrip": True,
                  "cross_tenant_reads_refused": True}
        Path("research/results/storage-smoke.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    finally:
        await pool.close()


def run():
    client = docker.from_env(timeout=10)
    container = None
    try:
        container = client.containers.run(CATALOG["postgresql"]["image"], detach=True,
            environment={"POSTGRES_USER": "synthetic", "POSTGRES_PASSWORD": "lab-only-password", "POSTGRES_DB": "synthetic"},
            ports={"5432/tcp": ("127.0.0.1", None)}, mem_limit="512m", nano_cpus=750000000,
            labels={"digital-twin.phase3.test": "storage"},
            tmpfs={"/var/lib/postgresql/data": "rw,size=256m"})
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if container.exec_run(["pg_isready", "-U", "synthetic", "-d", "synthetic"]).exit_code == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("PostgreSQL did not become ready")
        container.reload()
        port = int(container.attrs["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"])
        asyncio.run(verify(port))
    finally:
        if container is not None:
            container.remove(force=True, v=True)
        client.close()


if __name__ == "__main__":
    run()
