"""Exercise exception cleanup and abrupt-process reconciliation on Docker Desktop."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import docker

from twin_ingestion.phase2.engine import reconcile_labeled
from twin_ingestion.phase3.runtime import Lab


def scenario():
    path = Path(__file__).with_name("scenarios.json")
    return json.loads(path.read_text())["scenarios"][0]


def resources(client, worker_id):
    selector = {"label": f"digital-twin.phase2.worker={worker_id}"}
    return {"containers": len(client.containers.list(all=True, filters=selector)),
            "networks": len(client.networks.list(filters=selector))}


def run(output):
    worker_id = "cleanup-smoke-" + uuid4().hex
    client = docker.from_env(timeout=15)
    results = {"mode": "desktop_smoke", "worker_id": worker_id,
               "limitations": ["No Linux firewall or host/LAN/internet isolation assertion"]}
    try:
        try:
            with Lab(scenario(), "desktop_smoke", worker_id=worker_id):
                raise InterruptedError("seeded run interruption")
        except InterruptedError:
            pass
        results["after_exception"] = resources(client, worker_id)
        assert not any(results["after_exception"].values()), results

        child = subprocess.run([sys.executable, "-m", "research.cleanup_smoke", "--child",
                                "--worker-id", worker_id], capture_output=True, timeout=90)
        assert child.returncode == 77, "Seeded child did not exit at the interruption point"
        results["after_abrupt_exit"] = resources(client, worker_id)
        assert all(results["after_abrupt_exit"].values()), results
        reconcile_labeled(client, worker_id)
        results["after_reconciliation"] = resources(client, worker_id)
        assert not any(results["after_reconciliation"].values()), results
        results["passed"] = True
    finally:
        # Restrict every cleanup operation to this invocation's random worker label.
        try:
            reconcile_labeled(client, worker_id)
        finally:
            client.close()
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--worker-id")
    parser.add_argument("--output", default="research/results/cleanup-smoke.json")
    args = parser.parse_args()
    if args.child:
        if not args.worker_id or not args.worker_id.startswith("cleanup-smoke-"):
            parser.error("a cleanup-smoke worker ID is required")
        lab = Lab(scenario(), "desktop_smoke", worker_id=args.worker_id)
        lab.__enter__()
        os._exit(77)  # Simulate termination without context-manager cleanup.
    run(args.output)
