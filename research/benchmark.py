"""Same declared scenarios and budgets across four configurations; missing runs stay visible."""
from __future__ import annotations

import argparse
import copy
import csv
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import docker

from twin_ingestion.phase3.contracts import Limits, Report, Security, digest
from twin_ingestion.phase3.runtime import Lab, Unsupported
from twin_ingestion.phase3.tools import ToolExecutor
from twin_ingestion.phase3.model import configured_model, model_profile
from twin_ingestion.phase3.hunter import hunt, Trace
from twin_ingestion.phase3.patches import bounded_verify
from research.oracle import verify_truth

BASELINES = ["static_assessment", "default_twins", "synced_deterministic", "synced_twinhunter"]


def default_config(scenario):
    result = copy.deepcopy(scenario)
    for service in result["services"]:
        kind = service["kind"]
        name, value = {"nginx": ("server_tokens", "on"), "redis": ("protected-mode", "yes"),
                       "openssh": ("passwordauthentication", "no"), "postgresql": ("listen_addresses", "*")}[kind]
        service["directives"] = [{"order": 1, "name": name, "values": [value]}]
        service["hba_rules"] = [{"order": 1, "name": "rule", "values": ["host", "all", "all", "0.0.0.0/0", "scram-sha-256"]}] if kind == "postgresql" else []
        if service.get("upstream"):
            service["directives"].append({"order": 2, "name": "proxy_pass", "values": ["http://synthetic:8080"], "section": "http/server/location /"})
    return result


def static_assess(scenario):
    # A transparent config/version rule baseline, with no privileged oracle.
    from twin_ingestion.phase2.adapters import render
    s = scenario["services"][0]
    rendered = render(s["kind"], s["version"], s["directives"], s.get("hba_rules"), s.get("unsupported"), "synthetic:8080")
    if not rendered.supported:
        return "unsupported"
    directives = sorted(s["directives"], key=lambda d: d.get("order", 0))
    values = {}
    for d in directives:
        if s["kind"] == "openssh":
            values.setdefault(d["name"], d["values"][0])
        else:
            values[d["name"]] = d["values"][0]
    if scenario["test"] == "proxy_chain":
        positive = values.get("deny") != "all" and bool(s.get("upstream"))
    elif s["kind"] == "nginx":
        positive = values.get("server_tokens", "on") == "on"
    elif s["kind"] == "redis":
        positive = "requirepass" not in values and values.get("protected-mode", "yes") == "no"
    elif s["kind"] == "openssh":
        positive = values.get("passwordauthentication", "yes") == "yes" and values.get("denyusers") != "synthetic"
    else:
        positive = sorted(s.get("hba_rules", []), key=lambda d: d.get("order", 0))[0]["values"][-1] == "trust"
    return "positive" if positive else "negative"


def export_csv(path, rows):
    fields = ["scenario_id", "baseline", "repetition", "status", "prediction", "truth", "truth_verified", "elapsed_seconds",
              "readiness_seconds", "peak_ram_mb", "peak_cpu_millis", "cpu_seconds", "ram_mb_seconds",
              "reported_tokens", "reserved_tokens", "cost_usd", "snapshot_hash", "error"]
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def run(args):
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "research/scenarios.json").read_text())
    # Primary condition: Gemini 3.8 Flash via OmniRoute; TWIN_MODEL_BACKEND=local selects pinned Qwen.
    lock = model_profile()
    destinations = json.loads(Path(args.destinations).read_text()) if args.destinations else None
    scenarios = manifest["scenarios"]
    if args.scenarios:
        scenarios = [s for s in scenarios if s["id"] in args.scenarios.split(",")]
    if not scenarios or args.repetitions < 1:
        raise ValueError("nonempty scenarios and positive repetitions required")
    if args.endpoint and args.mode != "linux_isolated":
        raise ValueError("live AI execution requires Linux isolation prerequisites; Desktop supports deterministic smoke only")
    client = docker.from_env()
    info = client.info()
    environment = {"engine": client.version()["Version"], "cpus": info["NCPU"], "memory_bytes": info["MemTotal"],
                   "measured_at": datetime.now(timezone.utc).isoformat(), "physical_hosts_instrumented": 0,
                   "agent_overhead": None, "synchronization_latency": None,
                   "missing_metrics_reason": "No Phase 1 instrumented-host measurement imported in this experiment"}
    client.close()
    report = Report(run_id=str(uuid4()), created_at=datetime.now(timezone.utc).isoformat(), mode=args.mode,
        manifest_hash=digest(manifest), model_lock=lock, budgets={"cpu_millis": 2000, "ram_mb": 2048, **Limits().model_dump()},
        environment=environment, rows=[], limitations=["20 small policy fixtures, not a representative vulnerability corpus",
        "Ground truth independently wire-checked by a second implementation; external expert review pending",
        "Sampled resource peaks can miss sub-interval spikes",
        "AI results unavailable until a compatible model endpoint is hosted",
        "Source hosts are never patched", "VM comparison is not run on this Windows Docker Desktop host"])
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    def save():
        path = output / "report.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(report.model_dump_json(indent=2), encoding="utf-8")
        temporary.replace(path)
        export_csv(output / "results.csv", report.rows)
    ground_truth = {}
    for scenario in scenarios:
        try:
            with Lab(scenario, args.mode, destinations) as lab:
                truth, evidence = verify_truth(lab)
                ground_truth[scenario["id"]] = {"truth": truth, "verified": truth is not None and truth == scenario["proposed_truth"],
                    "proposed_truth": scenario["proposed_truth"], "evidence": evidence,
                    "source_snapshot": lab.snapshot_hash, "images": [t.image_id for t in lab.registry.values()]}
        except Exception as exc:
            ground_truth[scenario["id"]] = {"truth": None, "verified": False, "error": str(exc)[:1000]}
        (output / "ground-truth.json").write_text(json.dumps(ground_truth, indent=2), encoding="utf-8")
        print("oracle", scenario["id"], ground_truth[scenario["id"]].get("verified"), flush=True)
    for repetition in range(1, args.repetitions + 1):
        for scenario in scenarios:
            for baseline in BASELINES:
                started = time.monotonic()
                truth = ground_truth[scenario["id"]]
                row = {"scenario_id": scenario["id"], "baseline": baseline, "repetition": repetition,
                       "truth": truth["truth"], "truth_verified": truth["verified"], "snapshot_hash": digest(scenario),
                       "status": "inconclusive", "prediction": None, "cost_usd": None,
                       "cost_reason": "GPU billing rate not supplied; zero cost is not assumed", "evidence": [], "trace": []}
                lab = None
                try:
                    if baseline == "static_assessment":
                        answer = static_assess(scenario)
                        row.update(status="unsupported" if answer == "unsupported" else "completed",
                                   prediction={"positive": True, "negative": False}.get(answer),
                                   assessment_kind="static_inference_not_confirmed_finding")
                    elif baseline == "synced_twinhunter" and not args.endpoint:
                        row.update(status="unavailable", error="model endpoint not configured")
                    else:
                        configured = default_config(scenario) if baseline == "default_twins" else scenario
                        # Unsupported source fidelity is not erased by the default baseline.
                        if static_assess(scenario) == "unsupported":
                            raise Unsupported("source fidelity unsupported")
                        with Lab(configured, args.mode, destinations) as lab:
                            tools = ToolExecutor(lab, Limits())
                            first = next(iter(lab.registry.values()))
                            if baseline == "synced_twinhunter":
                                def patch(action):
                                    remaining = Limits().max_seconds - (time.monotonic() - tools.started)
                                    return bounded_verify(scenario, action.target_id, [c.model_dump() for c in action.changes],
                                                          args.mode, destinations, timeout=min(120, max(1, remaining)))
                                tools.patch_verifier = patch
                                result = hunt(configured_model(lock, args.endpoint, repetition - 1), tools, lab.state(), Limits(),
                                    Trace(output / "traces" / f"{report.run_id}-{scenario['id']}-{repetition}.jsonl"))
                                row.update(trace=result["trace"], evidence=result["evidence"],
                                    reported_tokens=result["reported_tokens"], reserved_tokens=result["reserved_tokens"],
                                    hunter_status=result["status"], model_identity=result["model"])
                                report.patches.extend(result["patches"])
                                tests = [e for e in result["evidence"] if e["tool"] == "security_check" and e["target_id"] == first.id]
                                verdict = tests[-1]["verdict"] if tests else "inconclusive"
                            else:
                                evidence = tools.execute(Security(name="security_check", target_id=first.id, port=first.port))
                                row["evidence"] = [evidence]
                                verdict = evidence["verdict"]
                            row.update(status="completed" if verdict in {"confirmed", "not_reproduced"} else verdict,
                                       prediction={"confirmed": True, "not_reproduced": False}.get(verdict),
                                       readiness_seconds=lab.readiness_seconds, rendered_snapshot=lab.snapshot_hash,
                                       fidelity_gaps=[g for t in lab.registry.values() for g in t.fidelity_gaps],
                                       path_kind="confirmed_synthetic_proxy_behavior" if scenario["test"] == "proxy_chain" and verdict == "confirmed" else "no_confirmed_attack_chain")
                except Exception as exc:
                    row.update(status="unsupported" if isinstance(exc, Unsupported) else "error", error=str(exc)[:1000])
                if lab:
                    row.update(lab.metrics)
                    row["cleanup_errors"] = lab.cleanup_errors
                row["elapsed_seconds"] = time.monotonic() - started
                report.rows.append(row)
                save()
                print(repetition, scenario["id"], baseline, row["status"], flush=True)
    if args.patches:
        cases = [
            ("valid", "s09", [{"field": "directives", "index": 1, "append_name": "requirepass", "value": "<redacted>"}]),
            ("invalid", "s09", [{"field": "directives", "index": 0, "value": "banana"}]),
            ("ineffective", "s09", [{"field": "directives", "index": 0, "value": "no"}]),
            ("breaking", "s05", [{"field": "hba_rules", "index": 0, "value": "reject"}])]
        for name, sid, edits in cases:
            source = next(s for s in manifest["scenarios"] if s["id"] == sid)
            result = bounded_verify(source, "target", edits, args.mode, destinations)
            result["seeded_case"] = name
            report.patches.append(result)
            save()
            print("patch", name, result["label"], flush=True)
    save()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["desktop_smoke", "linux_isolated"])
    parser.add_argument("--destinations")
    parser.add_argument("--endpoint", default=os.environ.get("TWIN_MODEL_ENDPOINT"))
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--scenarios")
    parser.add_argument("--patches", action="store_true")
    parser.add_argument("--output", default="research/results/local")
    run(parser.parse_args())
