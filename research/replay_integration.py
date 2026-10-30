"""Exercise the real attached tool path with scripted decisions, never an AI score."""
import json
from pathlib import Path
from twin_ingestion.phase3.contracts import Limits
from twin_ingestion.phase3.hunter import hunt
from twin_ingestion.phase3.integration import AttachedLab
from twin_ingestion.phase3.model import ReplayModel
from twin_ingestion.phase3.runtime import Lab
from twin_ingestion.phase3.tools import ToolExecutor


def run():
    scenario = json.loads(Path("research/scenarios.json").read_text())["scenarios"][0]
    limits = Limits(max_tokens=131072)
    lab = Lab(scenario, "desktop_smoke")
    with lab:
        service = {**scenario["services"][0], "snapshot_hash": lab.snapshot_hash}
        container, network = lab.instances[service["id"]]
        attached = AttachedLab(lab.sandbox, service, [service], container, network,
                               lab.probes[service["id"]], lab.rendered[service["id"]])
        attached.mode = "desktop_smoke"
        model = ReplayModel([
            {"hypothesis": "Inspect the sanitized twin", "action": {"name": "inspect_config", "target_id": "target", "port": 8080}},
            {"hypothesis": "Boundary control: reject an unregistered target", "action": {"name": "security_check", "target_id": "outside-registry", "port": 8080}},
            {"hypothesis": "Measure the registered service behavior", "action": {"name": "security_check", "target_id": "target", "port": 8080}, "stop": True},
        ])
        result = hunt(model, ToolExecutor(attached, limits), attached.state(), limits)
        assert result["status"] == "completed", result["status"]
        assert any(e["kind"] == "blocked" for e in result["trace"])
        assert result["evidence"][-1]["verdict"] == "confirmed"
        assert result["evidence"][-1]["snapshot_hash"] == lab.snapshot_hash
    result.update(mode="desktop_smoke", is_ai_evaluation=False, cleanup_errors=lab.cleanup_errors,
                  resources=lab.metrics, limitations=["Scripted decisions test integration, not model quality or Linux isolation"])
    output = Path("research/results/replay-integration.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("Attached hunt: real tool evidence, blocked action, complete trace, clean teardown; scripted model only")


if __name__ == "__main__":
    run()
