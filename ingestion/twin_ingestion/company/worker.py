"""Host-side company jobs; the API container never receives Docker access."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import asyncpg

from ..graph import GraphStore
from ..settings import Settings
from ..phase3.contracts import Limits
from ..phase3.hunter import hunt, Trace
from ..phase3.model import configured_model, model_profile
from ..phase3.model import ReplayModel
from .contracts import discover
from .runtime import CompanyLab
from .store import CompanyStore
from .verification import CompanyExecutor, SYSTEM


def execute(tenant, run_id, artifact, discovery, catalog, model, trace_path=None):
    result = {"schema_version": "company-run.1", "run_id": str(run_id), "tenant_id": tenant,
              "created_at": datetime.now(timezone.utc).isoformat(), "artifact": artifact.model_dump(),
              "discovery": discovery, "status": "failed", "scope": "docker_desktop_application_behavior",
              "assumptions": ["Employee client already compromised; synthetic employee credential available"],
              "limitations": ["One declared synthetic application; no general exploit or desktop cloning claim",
                              "Docker segmentation measured; dedicated host/LAN/internet firewall gate not certified"]}
    lab = CompanyLab(tenant, artifact, catalog)
    with lab:
        result["original"] = lab.identity()
        result["credential_scope"] = lab.credential_scope()
        if not all(result["credential_scope"].values()):
            raise RuntimeError("compromised employee credential boundary failed")
        result["isolation"] = lab.isolation()
        if not result["isolation"]["passed"]:
            raise RuntimeError("company segmentation checks failed")
        limits = Limits(max_steps=8, max_tokens=65536, max_seconds=360)
        result["budgets"] = {**limits.model_dump(), "model_response_deadline_seconds": 60,
                             "original_and_candidate_cpu_millis": 1900,
                             "original_and_candidate_ram_mb": 2176}
        executor = CompanyExecutor(lab, catalog, limits)
        if model == "scripted-boundary-smoke":
            actions = [
                {"name": "company_probe", "operation": "ordinary"},
                {"name": "company_probe", "operation": "restricted"},
                {"name": "company_patch", "policy": "enforce_record_authorization"}]
            model = ReplayModel([{"hypothesis": "Scripted integration boundary smoke; not AI discovery",
                                  "action": {**a, "target_id": lab.target_id, "port": 8080},
                                  "stop": i == 2} for i, a in enumerate(actions)])
        result["hunter"] = hunt(model, executor, executor.state(), limits,
                                Trace(trace_path), system_prompt=SYSTEM, model_timeout_seconds=60,
                                completion_check=lambda: any(p.get("label") == "verified in the tested company twin"
                                    and p.get("candidate_cleanup") == "complete" for p in executor.patches))
        confirmed = any(e.get("tool") == "company_probe" and e.get("verdict") == "confirmed"
                        and e.get("chain_verified") for e in executor.evidence)
        verified = any(p.get("label") == "verified in the tested company twin" for p in executor.patches)
        result["attack_path_confirmed"] = confirmed
        result["repair_verified"] = verified
        result["checks"] = {"source_discovered": True, "same_release_reproduced": True,
                            "attack_path_confirmed": confirmed, "repair_verified": verified,
                            "hunter_completed": result["hunter"]["status"] == "completed",
                            "trace_integrity": result["hunter"]["trace_integrity"]["verified"]}
    result["cleanup"] = "complete"
    if all(result["checks"].values()):
        result["status"] = "completed"
    return result


async def work(args):
    settings = Settings()
    pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=3)
    store = CompanyStore(pool)
    await store.ensure_schema()
    graph = GraphStore(settings.neo4j_uri, settings.neo4j_user, settings.neo4j_password)
    await graph.open()
    catalog = json.loads(Path(args.catalog).read_text())
    worker_id = "company-" + uuid4().hex
    count = 0
    try:
        while True:
            row = await store.claim(worker_id)
            if row is None:
                if args.once:
                    break
                await asyncio.sleep(2)
                continue
            tenant = row["tenant_id"]
            try:
                artifact = await store.artifact(tenant, row["artifact_id"])
                current = discover(artifact, await graph.topology(tenant))
                if current["services"] != row["discovery"]["services"]:
                    raise ValueError("source configuration changed after job admission")
                model = "scripted-boundary-smoke" if args.scripted else configured_model(model_profile(), os.environ.get("TWIN_MODEL_ENDPOINT"))
                result = await asyncio.to_thread(execute, tenant, row["id"], artifact,
                    row["discovery"], catalog, model, Path(args.traces) / f"{row['id']}.jsonl")
                await store.finish(tenant, row["id"], result)
                print(json.dumps({"run_id": str(row["id"]), "status": result["status"]}), flush=True)
            except Exception as exc:
                # No exception text that could contain runtime secrets is persisted.
                await store.finish(tenant, row["id"], error=type(exc).__name__)
                print(json.dumps({"run_id": str(row["id"]), "status": "failed", "error": type(exc).__name__}), flush=True)
            count += 1
            if args.once or args.max_jobs and count >= args.max_jobs:
                break
    finally:
        await graph.close()
        await pool.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--traces", default="research/results/company-path/traces")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-jobs", type=int, default=0)
    parser.add_argument("--scripted", action="store_true", help="Boundary smoke only; explicitly recorded as not AI")
    asyncio.run(work(parser.parse_args()))
