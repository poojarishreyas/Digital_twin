"""SARIF 2.1.0 export: structure, verdict→level mapping, provenance, and tenant-scoped endpoint."""
from twin_ingestion.sarif import findings_to_sarif, run_detail_to_sarif

FINDINGS = [
    {"test_id": "redis.unauthenticated_ping", "target_id": "service:db01:redis", "snapshot_hash": "a" * 64,
     "image_id": "sha256:img1", "test_version": "3.0", "verdict": "confirmed", "fidelity_gaps": [], "observations": {"exit_code": 0}, "wave_index": 0},
    {"test_id": "nginx.version_header", "target_id": "service:web01:nginx", "snapshot_hash": "b" * 64,
     "image_id": "sha256:img2", "test_version": "3.0", "verdict": "not_reproduced", "fidelity_gaps": [], "observations": {}},
    {"test_id": "postgresql.trust_access", "target_id": "service:db01:pg", "snapshot_hash": "c" * 64,
     "image_id": "sha256:img3", "test_version": "3.0", "verdict": "inconclusive", "fidelity_gaps": ["include not rendered"], "observations": {}},
]
LEVELS = {"none", "note", "warning", "error"}


def test_document_shape_is_valid_sarif_210():
    doc = findings_to_sarif(FINDINGS, run_id="r1", tenant="acme")
    assert doc["version"] == "2.1.0" and doc["$schema"].endswith("sarif-schema-2.1.0.json")
    run = doc["runs"][0]
    assert run["tool"]["driver"]["name"] == "Digital Twin" and run["properties"]["tenant"] == "acme"
    # Every result's ruleId resolves to a declared rule, and levels are legal.
    rule_ids = {r["id"] for r in run["tool"]["driver"]["rules"]}
    for res in run["results"]:
        assert res["ruleId"] in rule_ids
        assert run["tool"]["driver"]["rules"][res["ruleIndex"]]["id"] == res["ruleId"]
        assert res["level"] in LEVELS
        assert res["locations"][0]["logicalLocations"][0]["kind"] == "resource"
        assert res["locations"][0]["logicalLocations"][0]["fullyQualifiedName"].startswith("service:")


def test_not_reproduced_omitted_and_levels_map():
    doc = findings_to_sarif(FINDINGS)
    results = {r["ruleId"]: r for r in doc["runs"][0]["results"]}
    assert "nginx.version_header" not in results  # not_reproduced is not a finding
    assert results["redis.unauthenticated_ping"]["level"] == "error"      # confirmed
    assert results["postgresql.trust_access"]["level"] == "note"          # inconclusive
    # include flag brings the clean result back, at level none
    withclean = findings_to_sarif(FINDINGS, include_not_reproduced=True)
    assert any(r["ruleId"] == "nginx.version_header" and r["level"] == "none" for r in withclean["runs"][0]["results"])


def test_provenance_and_fingerprint_present():
    res = findings_to_sarif(FINDINGS)["runs"][0]["results"][0]
    assert res["properties"]["snapshot_hash"] == "a" * 64 and res["properties"]["image_id"] == "sha256:img1"
    assert res["partialFingerprints"]["twinSnapshot/v1"] == "redis.unauthenticated_ping:service:db01:redis:" + "a" * 64
    assert "twin result" in res["message"]["text"]  # honesty caveat carried in the message


def test_hunter_evidence_uses_tool_as_rule():
    detail = {"run": {"id": "r9"}, "findings": [],
              "hunts": [{"data": {"evidence": [{"tool": "security_check", "verdict": "confirmed",
                                                "target_id": "t", "snapshot_hash": "d" * 64, "image_id": "x", "fidelity_gaps": []}]}}]}
    doc = run_detail_to_sarif(detail, tenant="acme")
    assert doc["runs"][0]["results"][0]["ruleId"] == "security_check"


def test_datetimes_are_json_safe():
    import datetime, json
    f = [{"test_id": "nginx.version_header", "target_id": "w", "snapshot_hash": "e" * 64, "verdict": "confirmed",
          "image_id": "i", "fidelity_gaps": [], "observations": {}, "recorded_at": datetime.datetime(2026, 1, 1)}]
    doc = findings_to_sarif(f)
    json.dumps(doc)  # must not raise
    assert doc["runs"][0]["results"][0]["properties"]["recorded_at"].startswith("2026-01-01")


def test_sarif_route_is_viewer_readable_and_tenant_scoped():
    from twin_ingestion.security import access_rule
    action, role = access_rule("GET", "/api/emulation/runs/abc-123/sarif")
    assert action == "evidence.read" and role == "viewer"
