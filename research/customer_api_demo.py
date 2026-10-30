"""Optus-style exposed customer API: attack, repair and retest on a disposable synthetic twin.

Live Gemini (through OmniRoute) is the default model condition. `--scripted` runs a
separately labeled non-AI integration smoke. Nothing here touches a real system.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ingestion"))

from twin_ingestion.customer_api.contracts import CustomerDecision  # noqa: E402
from twin_ingestion.customer_api.runtime import CustomerApiLab  # noqa: E402
from twin_ingestion.customer_api.verification import CustomerApiExecutor, SYSTEM  # noqa: E402
from twin_ingestion.phase3.contracts import Limits, digest  # noqa: E402
from twin_ingestion.phase3.hunter import Trace, hunt  # noqa: E402
from twin_ingestion.phase3.model import ReplayModel, configured_model, model_profile  # noqa: E402

NODE_TAG = "digital-twin/customer-api:1.0.0"
DATABASE_IMAGE = "postgres@sha256:5d706d5aa3ad311722f373fdc09e6a22b454bec70d34d9786383983fd83c5e46"
VERIFIED = "verified in the tested customer API twin"
REFERENCES = [
    "Optus media statements, September 2022 (customer data exposure of up to ~9.8 million records)",
    "ACMA Federal Court proceedings against Optus, 2024 (alleged access-control coding error left an API exposed)",
]


def image_id(reference, build):
    def inspect():
        return subprocess.run(["docker", "image", "inspect", "-f", "{{.Id}}", reference],
                              capture_output=True, text=True)
    if build:
        subprocess.run(["docker", "build", "-f", "emulation/customer_api/Dockerfile", "-t", reference, "."],
                       cwd=ROOT, check=True)
    elif inspect().returncode and reference.startswith("postgres@"):
        subprocess.run(["docker", "pull", "-q", reference], check=True, capture_output=True)
    found = inspect()
    if found.returncode:
        raise SystemExit(f"Image {reference} is not available; build it or drop --no-build")
    return found.stdout.strip()


def scripted(target_id):
    actions = [{"name": "inspect_config"},
               {"name": "customer_api_probe", "operation": "lookup"},
               {"name": "customer_api_probe", "operation": "enumerate"},
               {"name": "customer_api_patch", "policy": "require_customer_authorization"}]
    return ReplayModel([{"hypothesis": "Scripted integration smoke; not AI discovery",
                         "action": {**a, "target_id": target_id, "port": 8080}, "stop": i == len(actions) - 1}
                        for i, a in enumerate(actions)])


def narrate(report):
    print("\n=== Exposed customer API (modeled on the 2022 Optus breach) ===")
    print(f"tenant {report['tenant_id']} | model {report['model_condition']} | status {report['status']}")
    for event in report["hunter"]["trace"]:
        payload = event["payload"]
        if event["kind"] == "hypothesis":
            print(f"\n[hunter] {payload['text'][:300]}")
        elif event["kind"] == "action":
            print(f"  -> {payload['name']} {payload.get('operation') or payload.get('policy') or ''}")
        elif event["kind"] == "blocked":
            print(f"  !! blocked: {payload.get('reason')}")
        elif event["kind"] == "observation" and payload.get("tool") == "customer_api_probe":
            print(f"  <- {payload['records_exposed']}/{payload['requested']} synthetic customer records returned "
                  f"without authentication; verdict {payload['verdict']}")
            if payload.get("masked_sample"):
                print(f"     sample (masked): {json.dumps(payload['masked_sample'])}")
        elif event["kind"] == "observation" and payload.get("tool") == "customer_api_patch":
            print(f"  <- candidate repair: {payload['label']}")
            print(f"     before: {payload['original_security']['records_exposed']} records exposed; "
                  f"after: {payload.get('security_retest', {}).get('records_exposed', '?')} exposed, "
                  f"neighbour read {payload.get('cross_customer_retest', {}).get('verdict', '?')}, "
                  f"legitimate workflows {'pass' if payload.get('candidate_workflows', {}).get('passed') else 'FAIL'}")
    print("\nchecks:", json.dumps(report["checks"], indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", default="acme-telco")
    parser.add_argument("--scripted", action="store_true", help="Non-AI integration smoke; live Gemini is the default")
    parser.add_argument("--no-build", action="store_true", help=f"Use an existing {NODE_TAG} image")
    parser.add_argument("--out", type=Path, default=ROOT / "research/results/customer-api")
    args = parser.parse_args()
    if not args.scripted and not os.environ.get("TWIN_MODEL_API_KEY"):
        raise SystemExit("Set TWIN_MODEL_API_KEY for a live Gemini run, or pass --scripted for a non-AI smoke")
    images = {"node_image": image_id(NODE_TAG, not args.no_build), "database_image": image_id(DATABASE_IMAGE, False)}
    run_id = str(uuid4())
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": "customer-api-run.1", "run_id": run_id, "tenant_id": args.tenant,
              "created_at": datetime.now(timezone.utc).isoformat(), "status": "failed",
              "scenario": "exposed customer API with sequential identifiers",
              "modeled_on": {"incident": "Optus, September 2022", "public_references": REFERENCES,
                             "fidelity": "attack pattern only; synthetic services and people; not Optus systems"},
              "model_condition": "scripted_smoke_not_ai" if args.scripted else "live_gemini",
              "images": images,
              "assumptions": ["Attacker is an anonymous internet client with no credentials"],
              "limitations": ["One declared synthetic application; no claim about real Optus architecture",
                              "Docker segmentation measured; host/LAN/internet firewall gate not certified"]}
    lab = CustomerApiLab(args.tenant, images)
    with lab:
        report["original"] = lab.identity()
        report["credential_scope"] = lab.credential_scope()
        report["isolation"] = lab.isolation()
        if not all(report["credential_scope"].values()) or not report["isolation"]["passed"]:
            raise SystemExit("Boundary checks failed; refusing to run the hunter")
        limits = Limits(max_steps=8, max_tokens=65536, max_seconds=360)
        executor = CustomerApiExecutor(lab, images, limits)
        model = scripted(lab.target_id) if args.scripted else configured_model(model_profile(), os.environ.get("TWIN_MODEL_ENDPOINT"))
        report["hunter"] = hunt(model, executor, executor.state(), limits, Trace(args.out / f"{run_id}.trace.jsonl"),
                                system_prompt=SYSTEM, model_timeout_seconds=60, decision_model=CustomerDecision,
                                completion_check=lambda: any(p.get("label") == VERIFIED for p in executor.patches))
    report["cleanup"] = "complete"
    probes = [e for e in executor.evidence if e.get("tool") == "customer_api_probe"]
    report["checks"] = {
        "single_record_exposed": any(e["operation"] == "lookup" and e["verdict"] == "confirmed" for e in probes),
        "bulk_enumeration_confirmed": any(e["operation"] == "enumerate" and e["verdict"] == "confirmed" for e in probes),
        "repair_verified": any(p.get("label") == VERIFIED for p in executor.patches),
        "hunter_completed": report["hunter"]["status"] == "completed",
        "trace_integrity": report["hunter"]["trace_integrity"]["verified"]}
    if all(report["checks"].values()):
        report["status"] = "completed"
    report["report_hash"] = digest(report)
    path = args.out / f"{run_id}.json"
    path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    narrate(report)
    print(f"\nreport: {path}")
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
