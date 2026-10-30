from copy import deepcopy
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from twin_ingestion.api import EventHub, create_app
from twin_ingestion.path_analysis import analyze_paths
from twin_ingestion.phase2.planner import enumerate_paths
from twin_ingestion.settings import Settings

NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)


def fixture():
    nodes = [{"id": n, "labels": ["Asset", "Host"], "properties": {
        "agent_id": n, "entry": n == "entry", "critical": n == "database"}}
        for n in ("entry", "gateway", "alternate", "database")]
    edges = [edge(a, b) for a, b in (("entry", "gateway"), ("gateway", "database"),
                                   ("entry", "alternate"), ("alternate", "database"))]
    agents = [{"agent_id": n["id"], "stale": False, "needs_full": False, "gaps": []} for n in nodes]
    return {"nodes": nodes, "edges": edges}, agents


def edge(source, target, kind="OBSERVED_CONNECTION"):
    return {"source": source, "target": target, "kind": kind, "properties": {
        "observed_at": NOW.isoformat(), "evidence_source": "lab-socket", "confidence": "observed"}}


def test_paths_preserve_evidence_and_never_claim_exploitation():
    topology, agents = fixture()
    result = analyze_paths(topology, agents, now=NOW)
    assert len(result["paths"]) == 2
    assert all(p["validation_status"] == "unvalidated" and p["telemetry_complete"] for p in result["assessments"])
    assert result["paths"][0][0]["evidence_source"] == "lab-socket"
    assert not result["universe"]["truncated"]
    assert {p["asset_id"] for p in result["review_points"]} == {"alternate", "gateway"}


def test_stale_missing_and_future_evidence_and_agent_gaps_are_visible():
    topology, agents = fixture()
    topology["edges"][0]["properties"]["observed_at"] = "2026-10-26T12:00:00Z"
    topology["edges"][1]["properties"] = {}
    topology["edges"][2]["properties"]["observed_at"] = "2026-10-28T12:00:00Z"
    agents[0].update(stale=True, needs_full=True, gaps='[{"reason":"permission_denied"}]')
    result = analyze_paths(topology, agents, now=NOW)
    reasons = {i["reason"] for p in result["assessments"] for i in p["issues"]}
    assert {"edge_evidence_stale", "edge_evidence_unknown", "edge_evidence_future", "missing_evidence_source",
            "evidence_semantics_mismatch", "stale_agent", "snapshot_reconciliation_required", "collection_gaps"} <= reasons
    assert all(not p["telemetry_complete"] for p in result["assessments"])


def test_isolation_preview_is_immutable_and_preserves_alternative_route():
    topology, agents = fixture()
    before = deepcopy(topology)
    result = analyze_paths(topology, agents, isolated_asset="gateway", now=NOW)
    assert result["isolation_preview"]["affected_count"] == 1
    assert result["isolation_preview"]["remaining_count"] == 1
    assert topology == before
    assert len(result["paths"]) == 2


def test_confirmed_and_archetype_edges_cannot_create_candidate_routes():
    topology, agents = fixture()
    topology["edges"] = [edge("entry", "database", "CONFIRMED_ATTACK_TRANSITION"),
                         edge("entry", "database", "INSTANCE_OF")]
    result = analyze_paths(topology, agents, now=NOW)
    assert not result["paths"]
    assert result["universe"]["excluded_edges"] == {"CONFIRMED_ATTACK_TRANSITION": 1, "INSTANCE_OF": 1}
    assert any("does not establish safety" in w for w in result["warnings"])


def test_missing_endpoints_and_truncation_never_look_complete():
    topology, agents = fixture()
    topology["nodes"][0]["properties"]["entry"] = False
    topology["truncated_edges"] = True
    result = analyze_paths(topology, agents, now=NOW)
    assert not result["paths"] and result["universe"]["truncated"]
    assert any("entry asset" in w for w in result["warnings"])


def test_deduplicated_stable_paths_and_global_traversal_budget():
    topology, agents = fixture()
    result = analyze_paths(topology, agents, now=NOW)
    topology["edges"] = list(reversed(topology["edges"] * 2))
    again = analyze_paths(topology, agents, now=NOW)
    assert [p["id"] for p in result["assessments"]] == [p["id"] for p in again["assessments"]]
    edges = [edge("entry", str(i)) for i in range(100)]
    paths, truncated, _ = enumerate_paths(["entry"], ["missing"], edges, 4, max_states=10)
    assert truncated and not paths
    limited = analyze_paths(topology, agents, max_paths=1, now=NOW)
    assert len(limited["paths"]) == 1 and limited["universe"]["traversal_truncated"]


def test_component_uses_owning_host_health_without_merging_identity():
    topology, agents = fixture()
    topology["nodes"].append({"id": "endpoint", "labels": ["Asset"], "properties": {"critical": True}})
    topology["edges"] = [edge("entry", "endpoint")]
    result = analyze_paths(topology, agents, now=NOW)
    assert result["assessments"][0]["issues"][0]["reason"] == "unmanaged_or_unresolved_asset"
    topology["edges"].append(edge("database", "endpoint", "HAS_SERVICE"))
    agents[-1]["stale"] = True
    result = analyze_paths(topology, agents, now=NOW)
    assert {i["reason"] for i in result["assessments"][0]["issues"]} == {"stale_agent"}


def test_paths_api_keeps_legacy_shape_and_validates_preview_and_depth():
    topology, agents = fixture()
    class Graph:
        async def topology(self, tenant): return topology
    class History:
        async def inventory(self, tenant, stale): return agents
    client = TestClient(create_app(Settings(auth_mode="lab"), History(), Graph(), EventHub()))
    response = client.get("/api/paths?max_depth=4&isolated_asset=gateway")
    assert response.status_code == 200
    assert len(response.json()["paths"]) == 2
    assert response.json()["isolation_preview"]["remaining_count"] == 1
    assert client.get("/api/paths?isolated_asset=outside-graph").status_code == 404
    assert client.get("/api/paths?max_depth=9").status_code == 400
    assert client.get("/api/paths?max_depth=0").status_code == 422
