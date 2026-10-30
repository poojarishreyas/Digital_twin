"""Run fixed Phase 2 acceptance fixtures on the dedicated Linux sandbox host.

Requires root, a running Docker Engine, locally prepared images, and three
operator controlled TCP listeners specified in the destinations JSON file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import docker
from twin_ingestion.phase2.adapters import CATALOG, render
from twin_ingestion.phase2.engine import Sandbox, reconcile_labeled
from twin_ingestion.phase2.worker import behavior, sampled_resources


def fixture_case(client, worker_id: str, destinations: dict, fixture: dict) -> dict:
    run_id = str(uuid4())
    sandbox = Sandbox(client, run_id, worker_id, destinations)
    try:
        controls = sandbox.positive_controls()
        if not all(controls.values()):
            raise RuntimeError(f"positive controls unavailable: {controls}")
        rendered = render(fixture["service"], fixture["version"], fixture["directives"], fixture.get("hba_rules"))
        if not rendered.supported:
            raise RuntimeError(f"fixture unrenderable: {rendered.fidelity_gaps}")
        service = {"id": f"fixture:{fixture['service']}:{fixture['case']}", "kind": fixture["service"],
                   "directives": fixture["directives"], "hba_rules": fixture.get("hba_rules", [])}
        container, net = sandbox.launch_service(service, rendered)
        sandbox.start_service(container, rendered)
        ready, detail = sandbox.readiness(container, fixture["service"])
        if not ready:
            raise RuntimeError(f"not ready: {detail}")
        probe = sandbox.probe_container(service["id"], net)
        isolation = sandbox.isolation(probe, container.name, rendered.port)
        result = behavior(sandbox, probe, service, container, rendered.port)
        cpu, ram = sampled_resources(sandbox.containers)
        budget = {"cpu_millis": CATALOG[fixture["service"]]["cpu_millis"] + 200,
                  "ram_mb": CATALOG[fixture["service"]]["ram_mb"] + 128}
        return {"case": service["id"], "expected": fixture["expected"], "observed": result["verdict"],
                "isolation": isolation, "ready": ready, "cpu_millis": cpu, "ram_mb": ram,
                "budget": budget, "passed": isolation["passed"] and result["verdict"] == fixture["expected"]
                and cpu <= budget["cpu_millis"] and ram <= budget["ram_mb"]}
    finally:
        errors = sandbox.cleanup()
        if errors:
            raise RuntimeError(f"cleanup failed: {errors}")


def multihop_case(client, worker_id: str, destinations: dict) -> dict:
    run_id = str(uuid4())
    sandbox = Sandbox(client, run_id, worker_id, destinations)
    try:
        if not all(sandbox.positive_controls().values()):
            raise RuntimeError("positive controls unavailable")
        source_id, target_id = "fixture:nginx:front", "fixture:nginx:back"
        target_name = f"dt-{sandbox.short}-{hashlib.sha256(target_id.encode()).hexdigest()[:6]}"
        source = render("nginx", "1.27.5", [{"order": 1, "name": "proxy_pass", "values": ["http://original-backend:8080"], "section": "http/server/location /"}],
                        upstream_alias=f"{target_name}:8080", instance_marker="front")
        target_marker = hashlib.sha256(target_id.encode()).hexdigest()[:12]
        target = render("nginx", "1.27.5", [{"order": 1, "name": "server_tokens", "values": ["off"]}],
                        instance_marker=target_marker)
        front, front_net = sandbox.launch_service({"id": source_id}, source)
        back, back_net = sandbox.launch_service({"id": target_id}, target)
        link = sandbox.network("link-fixture")
        link.connect(front, aliases=[front.name])
        link.connect(back, aliases=[back.name])
        sandbox.start_service(back, target)
        sandbox.start_service(front, source)
        ready = all([sandbox.readiness(front, "nginx")[0], sandbox.readiness(back, "nginx")[0]])
        probe = sandbox.probe_container("fixture:multihop", front_net)
        isolation = sandbox.isolation(probe, front.name, 8080, denied_name=back.name)
        code, output = sandbox.exec(probe, ["curl", "-sS", "--max-time", "4", f"http://{front.name}:8080/"])
        cpu, ram = sampled_resources(sandbox.containers)
        passed = ready and isolation["passed"] and code == 0 and f"synthetic twin {target_marker}" in output
        return {"case": "nginx-front-to-nginx-back", "ready": ready, "isolation": isolation,
                "target_marker_seen": f"synthetic twin {target_marker}" in output,
                "cpu_millis": cpu, "ram_mb": ram, "passed": passed and cpu <= 700 and ram <= 384}
    finally:
        errors = sandbox.cleanup()
        if errors:
            raise RuntimeError(f"cleanup failed: {errors}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--destinations", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=2)
    args = parser.parse_args()
    destinations = json.loads(args.destinations.read_text(encoding="utf-8"))
    fixtures = json.loads((Path(__file__).parent / "fixtures" / "core-behavior.json").read_text(encoding="utf-8"))
    client = docker.from_env()
    worker_id = "lab-acceptance"
    reconcile_labeled(client, worker_id)
    results = []
    for repetition in range(args.repetitions):
        for fixture in fixtures:
            results.append({"repetition": repetition + 1, **fixture_case(client, worker_id, destinations, fixture)})
        results.append({"repetition": repetition + 1, **multihop_case(client, worker_id, destinations)})
    report = {"passed": all(result["passed"] for result in results), "results": results}
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

