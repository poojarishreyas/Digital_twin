"""TwinHunter protocol 3.1 (duplicate guard, harness control, trace integrity) and research insights."""
import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient
from twin_ingestion.api import EventHub, create_app
from twin_ingestion.phase3.contracts import Limits
from twin_ingestion.phase3.hunter import hunt, verify_trace
from twin_ingestion.phase3.insights import disagreements, insights, patch_funnel
from twin_ingestion.phase3.model import ReplayModel
from twin_ingestion.phase3.tools import ToolExecutor
from twin_ingestion.settings import Settings
from test_phase3_boundaries import FakeLab
from test_security import Graph, History

ROOT = Path(__file__).resolve().parents[2]
CHECK = {"name": "security_check", "target_id": "target", "port": 8080}


class RecordingModel(ReplayModel):
    def __init__(self, decisions):
        super().__init__(decisions)
        self.seen = []

    def decide(self, messages, *args):
        self.seen.append(json.loads(messages[-1]["content"]))
        return super().decide(messages, *args)


def test_duplicate_action_reuses_observation_without_network():
    lab = FakeLab()
    model = ReplayModel([{"hypothesis": "check", "action": CHECK, "stop": False},
                         {"hypothesis": "check again", "action": CHECK, "stop": True}])
    result = hunt(model, ToolExecutor(lab, Limits()), {}, Limits())
    after_first = len(lab.commands)
    assert after_first > 0
    duplicates = [e for e in result["trace"] if e["kind"] == "blocked" and e["payload"]["status"] == "duplicate"]
    assert len(duplicates) == 1 and len(result["evidence"]) == 1
    assert len(lab.commands) == after_first  # No second probe was sent.
    assert result["protocol"] == "3.1" and result["trace_integrity"]["verified"]


def test_harness_control_reports_budget_and_coverage():
    model = RecordingModel([{"hypothesis": "inspect", "action": CHECK, "stop": False},
                            {"hypothesis": "done", "action": None, "stop": True}])
    hunt(model, ToolExecutor(FakeLab(), Limits(max_steps=5)), {"note": "untrusted"}, Limits(max_steps=5))
    first, second = model.seen[0]["harness_control"], model.seen[1]["harness_control"]
    assert first["steps_remaining"] == 5 and first["coverage"] == {}
    assert second["steps_remaining"] == 4 and second["coverage"] == {"target": ["security_check"]}
    assert second["tokens_remaining"] < first["tokens_remaining"]
    assert "untrusted_tool_observation" in model.seen[1]  # Observations stay labelled untrusted.


def test_verify_trace_detects_edit_reorder_and_drop():
    model = ReplayModel([{"hypothesis": "check", "action": CHECK, "stop": True}])
    events = hunt(model, ToolExecutor(FakeLab(), Limits()), {}, Limits())["trace"]
    assert verify_trace(events) == {"verified": True, "events": len(events), "first_invalid": None}
    edited = copy.deepcopy(events)
    edited[1]["payload"]["target_id"] = "elsewhere"
    assert verify_trace(edited)["first_invalid"] == 1
    assert verify_trace(events[:1] + events[2:])["first_invalid"] == 1
    assert verify_trace(list(reversed(events)))["first_invalid"] == 0
    # A stored report round-trips through JSON without breaking the chain.
    assert verify_trace(json.loads(json.dumps(events)))["verified"]


def row(scenario, baseline, prediction, truth=True, status="completed", trace=None, evidence=None):
    return {"scenario_id": scenario, "baseline": baseline, "repetition": 1, "status": status, "prediction": prediction,
            "truth": truth, "truth_verified": True, "elapsed_seconds": 1.0, "trace": trace or [], "evidence": evidence or []}


def test_disagreements_never_count_abstention_as_correct():
    rows = [row("s1", "static", True), row("s1", "hunter", False),               # split
            row("s2", "static", False), row("s2", "hunter", None, status="unavailable"),  # one answer only
            row("s3", "static", False), row("s3", "hunter", False)]              # all wrong
    found = {d["scenario_id"]: d for d in disagreements(rows)}
    assert found["s1"]["kind"] == "split" and found["s1"]["correct_methods"] == ["static"]
    assert found["s3"]["kind"] == "all_wrong" and found["s3"]["correct_methods"] == []
    assert "s2" in found and found["s2"]["kind"] == "all_wrong"
    assert found["s2"]["methods"]["hunter"]["outcome"] == "unavailable"


def test_agent_behaviour_from_real_hunt_traces():
    model = ReplayModel([{"hypothesis": "unknown target", "action": {**CHECK, "target_id": "external"}, "stop": False},
                         {"hypothesis": "check", "action": CHECK, "stop": False},
                         {"hypothesis": "again", "action": CHECK, "stop": True}])
    result = hunt(model, ToolExecutor(FakeLab(), Limits()), {}, Limits())
    report = {"rows": [row("s1", "synced_twinhunter", True, trace=result["trace"], evidence=result["evidence"])], "patches": []}
    agent = insights(report)["agent"]["synced_twinhunter"]
    assert agent["actions_total"] == 3 and agent["tool_usage"] == {"security_check": 3}
    assert agent["blocked_reasons"]["duplicate action"] == 1 and len(agent["blocked_reasons"]) == 2
    assert agent["steps_to_conclusive_evidence"]["mean"] == 2
    assert agent["finish_status"] == {"completed": 1} and agent["evidence_backed_positive_rate"] == 1
    assert agent["trace_integrity"] == {"verified": 1, "checked": 1, "broken": []}
    report["rows"][0]["trace"][2]["payload"]["port"] = 1
    assert insights(report)["agent"]["synced_twinhunter"]["trace_integrity"]["broken"][0]["first_invalid"] == 2


def test_insights_on_recorded_report():
    report = json.loads((ROOT / "research/results/repeated/report.json").read_text())
    result = insights(report)
    funnel = {stage["stage"]: stage["count"] for stage in result["patch_funnel"]}
    assert funnel["attempted"] == len(report["patches"]) and funnel["accepted"] == 1
    assert list(funnel.values()) == sorted(funnel.values(), reverse=True)  # A funnel never widens.
    assert result["agent"]["synced_twinhunter"]["traced_runs"] == 0  # Unavailable model: no fabricated behaviour.
    assert any(d["kind"] == "split" and "static_assessment" in d["correct_methods"] for d in result["disagreements"])


def test_patch_funnel_stops_at_first_failed_stage():
    patches = [{"label": "rejected", "checks": {"original_security": {"verdict": "confirmed"}, "original_workflow": True, "syntax_and_startup": False}}]
    assert [s["count"] for s in patch_funnel(patches)] == [1, 1, 1, 0, 0, 0, 0]


def test_insights_endpoint_is_read_only():
    report = json.loads((ROOT / "research/results/repeated/report.json").read_text())
    app = create_app(Settings(auth_mode="lab", allowed_origins="http://testserver"), History(), Graph(), EventHub())
    response = TestClient(app).post("/api/research/insights", json=report)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"summary", "insights"} and body["insights"]["patch_funnel"][0]["count"] == len(report["patches"])
