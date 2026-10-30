"""Measured matched container subset, separate synthetic graph, explicit VM exclusion."""
import argparse
import copy
import json
import time
from pathlib import Path
from twin_ingestion.phase2.planner import Service, plan
from twin_ingestion.phase3.runtime import Lab
from twin_ingestion.phase3.tools import ToolExecutor
from twin_ingestion.phase3.contracts import Limits, Security


def run(args):
    manifest = json.loads(Path("research/scenarios.json").read_text())
    services = []
    for i, index in enumerate([0, 1, 8, 9]):
        service = copy.deepcopy(manifest["scenarios"][index]["services"][0])
        service["id"] = f"h{i}"
        services.append(service)
    model_services = [Service(s["id"], s["id"], s["kind"], s["version"], "synthetic", cpu_millis=250, ram_mb=128) for s in services]
    edge = [{"source": "h0", "target": "h1", "kind": "INFERRED_REACHABILITY"}]
    selection = plan(["h0"], ["h1"], edge, model_services, cpu_budget_millis=2000, ram_budget_mb=2048).as_dict()
    selected = set(selection["waves"][0]["service_ids"])
    records = []
    destinations = json.loads(Path(args.destinations).read_text()) if args.destinations else None
    for repetition in range(1, args.repetitions + 1):
        for policy in ("selective", "always_on"):
            subset = [s for s in services if s["id"] in selected] if policy == "selective" else services
            scenario = {"id": "scheduling-subset", "test": "service-policy", "services": subset, "links": []}
            started = time.monotonic()
            lab = Lab(scenario, args.mode, destinations)
            with lab:
                executor = ToolExecutor(lab, Limits())
                verdicts = {}
                for target_id in sorted(selected):
                    target = lab.registry[target_id]
                    verdicts[target_id] = executor.execute(Security(name="security_check", target_id=target_id, port=target.port))["verdict"]
                if policy == "always_on":
                    time.sleep(max(0, args.horizon - (time.monotonic() - started)))
            records.append({"repetition": repetition, "policy": policy, "container_services": len(subset),
                "same_test_targets": sorted(selected), "verdicts": verdicts, "active_seconds": time.monotonic() - started,
                "horizon_seconds": args.horizon, "readiness_seconds": lab.readiness_seconds, **lab.metrics,
                "cleanup_errors": lab.cleanup_errors})
            print(policy, repetition, flush=True)
    graph_services = [Service(f"n{i}", f"n{i}", "nginx", "1.27.5", "synthetic", cpu_millis=250, ram_mb=128) for i in range(100)]
    graph_edges = [{"source": f"n{i}", "target": f"n{i+1}", "kind": "INFERRED_REACHABILITY"} for i in range(99)]
    graph = plan(["n0", "n40", "n80"], ["n4", "n44", "n84"], graph_edges, graph_services, max_hops=4).as_dict()
    result = {"mode": args.mode, "matched_subset": "four real service containers; identical two tested targets",
        "selection": selection, "records": records,
        "synthetic_graph": {"nodes": 100, "physically_instrumented_hosts": 0, "purpose": "planner scaling only", "plan": graph},
        "full_vm_comparison": {"status": "not_run", "reason": "No controlled full-VM backend or matched hardware available"},
        "limitations": ["Candidate path coverage is not attack-path validation", "Always-on retains all four services for the declared horizon; selective destroys its selected services after the tests"]}
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--mode", required=True, choices=["desktop_smoke", "linux_isolated"])
    p.add_argument("--destinations")
    p.add_argument("--repetitions", type=int, default=3)
    p.add_argument("--horizon", type=float, default=20)
    p.add_argument("--output", default="research/results/scheduling.json")
    run(p.parse_args())
