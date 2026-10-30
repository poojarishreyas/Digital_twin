"""Export executed twin findings as SARIF 2.1.0.

SARIF (OASIS Static Analysis Results Interchange Format) lets these findings be
consumed by GitHub code scanning, IDE SARIF viewers and CI gates without a custom
format. Our findings are service/config results on twins rather than source-code
file/line issues, so each result anchors to a *logical* location (the target id)
and carries the twin provenance (snapshot hash, image id, fidelity gaps) as
properties. Only executed observations appear here — the same rule the executor
enforces; a `not_reproduced` verdict means the weakness was absent, so it is not a
finding and is omitted by default.
"""
from __future__ import annotations

SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json"
TOOL_NAME = "Digital Twin"
INFORMATION_URI = "https://example.invalid/digital-twin"

# verdict -> SARIF level. not_reproduced is "no weakness", omitted unless asked.
LEVEL = {"confirmed": "error", "inconclusive": "note", "unsupported": "note", "not_reproduced": "none"}
RULE_HELP = {
    "nginx.version_header": "Nginx discloses its version in the Server header.",
    "nginx.http_response": "Nginx HTTP behavior observed on the rendered twin.",
    "postgresql.trust_access": "PostgreSQL grants access without authentication (pg_hba trust).",
    "redis.unauthenticated_ping": "Redis accepts commands without authentication.",
    "openssh.password_auth": "OpenSSH permits password authentication for the tested account.",
}


def _rule_id(finding: dict) -> str:
    return str(finding.get("test_id") or finding.get("tool") or "twin.finding")


def _clean(value):
    """JSON-safe: datetimes and anything exotic become strings."""
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def findings_to_sarif(findings: list[dict], *, run_id: str = "", tenant: str = "",
                      include_not_reproduced: bool = False, tool_version: str = "4.0.0") -> dict:
    """Build a SARIF 2.1.0 document from executed finding/evidence dicts."""
    rules: dict[str, int] = {}
    rule_list: list[dict] = []
    results: list[dict] = []
    for finding in findings:
        verdict = str(finding.get("verdict", "inconclusive"))
        if verdict == "not_reproduced" and not include_not_reproduced:
            continue
        rule_id = _rule_id(finding)
        if rule_id not in rules:
            rules[rule_id] = len(rule_list)
            rule_list.append({
                "id": rule_id,
                "name": "".join(part.capitalize() for part in rule_id.replace(".", "_").split("_")),
                "shortDescription": {"text": RULE_HELP.get(rule_id, f"Twin policy check {rule_id}.")},
                "defaultConfiguration": {"level": LEVEL.get(verdict, "note")},
            })
        target = str(finding.get("target_id", "unknown-target"))
        snapshot = str(finding.get("snapshot_hash", ""))
        result = {
            "ruleId": rule_id,
            "ruleIndex": rules[rule_id],
            "level": LEVEL.get(verdict, "note"),
            "message": {"text": f"{rule_id} on {target}: {verdict.replace('_', ' ')} "
                                f"(twin result under recorded conditions; not proof of production exploitability)."},
            "locations": [{"logicalLocations": [{"fullyQualifiedName": target, "kind": "resource", "name": target.split(":")[-1]}]}],
            "properties": {
                "verdict": verdict, "snapshot_hash": snapshot, "image_id": str(finding.get("image_id", "")),
                "test_version": str(finding.get("test_version", "")), "fidelity_gaps": _clean(finding.get("fidelity_gaps", [])),
                "observations": _clean(finding.get("observations", {})),
                "wave_index": finding.get("wave_index"), "recorded_at": _clean(finding.get("recorded_at")),
            },
        }
        if snapshot:
            # Stable identity so re-runs on the same twin snapshot dedupe in consumers.
            result["partialFingerprints"] = {"twinSnapshot/v1": f"{rule_id}:{target}:{snapshot}"}
        results.append(result)

    run_props = {k: v for k, v in (("run_id", run_id), ("tenant", tenant)) if v}
    return {
        "version": "2.1.0",
        "$schema": SCHEMA,
        "runs": [{
            "tool": {"driver": {
                "name": TOOL_NAME, "informationUri": INFORMATION_URI, "version": tool_version,
                "rules": rule_list,
            }},
            "results": results,
            **({"properties": run_props} if run_props else {}),
        }],
    }


def run_detail_to_sarif(detail: dict, tenant: str = "", **kwargs) -> dict:
    """Convenience: SARIF for a RunStore.detail() payload (its findings + any hunt evidence)."""
    findings = list(detail.get("findings", []))
    for hunt in detail.get("hunts", []) or []:
        for evidence in (hunt.get("data", {}) or {}).get("evidence", []) or []:
            if evidence.get("verdict"):
                findings.append(evidence)
    run_id = str((detail.get("run") or {}).get("id", ""))
    return findings_to_sarif(findings, run_id=run_id, tenant=tenant, **kwargs)
