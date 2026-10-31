"""Evidence-aware candidate paths; no exploitation probability or validation claim."""
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json

from .phase2.planner import EDGE_KINDS, enumerate_paths


def _timestamp(value):
    try:
        stamp = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return stamp.astimezone(timezone.utc) if stamp.tzinfo else None
    except (ValueError, TypeError):
        return None


def analyze_paths(topology, inventory, max_depth=4, stale_after_seconds=180,
                  isolated_asset=None, now=None, max_paths=500, max_states=10000):
    now = now or datetime.now(timezone.utc)
    nodes = {n["id"]: n for n in topology["nodes"] if "Archetype" not in n.get("labels", [])}
    entries = sorted(k for k, n in nodes.items() if n["properties"].get("entry"))
    critical = sorted(k for k, n in nodes.items() if n["properties"].get("critical"))
    if isolated_asset is not None and isolated_asset not in nodes:
        raise KeyError("isolated asset is not in the current topology")
    agents = {a["agent_id"]: a for a in inventory}
    owners = defaultdict(set)
    for edge in topology["edges"]:
        if edge["kind"].startswith("HAS_") and "Host" in nodes.get(edge["source"], {}).get("labels", []):
            owners[edge["target"]].add(edge["source"])
    excluded = Counter()
    eligible = {}
    # Sandbox-confirmed hops never create a route; they upgrade hops on observed/inferred routes.
    confirmed = {}
    for edge in topology["edges"]:
        if edge["kind"] == "CONFIRMED_ATTACK_TRANSITION" and edge["source"] in nodes and edge["target"] in nodes:
            props = edge.get("properties", {})
            try:
                detail = json.loads(props.get("properties_json") or "{}")
            except (TypeError, ValueError):
                detail = {}
            confirmed[(edge["source"], edge["target"])] = {
                "evidence_source": props.get("evidence_source"), "observed_at": props.get("observed_at"),
                "basis": detail.get("basis", []), "test_ids": detail.get("test_ids", []), "run_id": detail.get("run_id")}
    for edge in topology["edges"]:
        if edge["kind"] not in EDGE_KINDS:
            excluded[edge["kind"]] += 1
            continue
        if edge["source"] not in nodes or edge["target"] not in nodes:
            excluded["missing_endpoint"] += 1
            continue
        key = (edge["source"], edge["target"], edge["kind"])
        props = edge.get("properties", {})
        step = {"source": key[0], "target": key[1], "kind": key[2],
                "observed_at": props.get("observed_at"), "evidence_source": props.get("evidence_source"),
                "confidence": props.get("confidence")}
        # Neo4j relationships are unique per typed pair. Select deterministically
        # if an imported/test snapshot contains duplicates.
        if key not in eligible or str(step["observed_at"] or "") > str(eligible[key]["observed_at"] or ""):
            eligible[key] = step
    raw, traversal_truncated = [], False
    if entries and critical:
        raw, traversal_truncated, _ = enumerate_paths(entries, critical, list(eligible.values()),
                                                       max_depth, max_paths, max_states)
    topology_truncated = bool(topology.get("truncated_nodes") or topology.get("truncated_edges"))
    assumptions = ["Directed observed/inferred edges; explicitly declared entry and critical assets.",
                   "Simple paths stop at the first critical asset and never repeat an asset.",
                   "Only uniquely matched enrolled workload listeners resolve remote endpoints; other unresolved endpoints limit multi-hop coverage.",
                   "Connectivity does not establish a usable credential, vulnerability, or privilege transition.",
                   "A hop is confirmed only when an observed connection reached a service whose isolated replica reproduced a weakness, or a sandboxed chain scenario passed it.",
                   "A path is proven only when every hop is confirmed; a finding on one service does not validate the rest of the chain."]
    warnings = []
    if not entries:
        warnings.append("Declare at least one entry asset.")
    if not critical:
        warnings.append("Declare at least one critical asset.")
    if topology_truncated or traversal_truncated:
        warnings.append("Analysis is truncated. Counts and isolation previews cover only the returned paths.")
    if not raw and entries and critical:
        warnings.append("No path was found within the collected topology and limits; this does not establish safety.")

    assessments = []
    for asset_ids, kinds in raw:
        steps = []
        issues = []
        for index, kind in enumerate(kinds):
            step = dict(eligible[(asset_ids[index], asset_ids[index + 1], kind)])
            stamp = _timestamp(step["observed_at"])
            age = (now - stamp).total_seconds() if stamp else None
            step["freshness"] = "unknown" if age is None else "future" if age < -60 else "stale" if age > stale_after_seconds else "current"
            step["age_seconds"] = round(max(0, age), 1) if age is not None else None
            if step["freshness"] != "current":
                issues.append({"asset_id": step["source"], "reason": "edge_evidence_" + step["freshness"], "step": index + 1})
            if not step["evidence_source"]:
                issues.append({"asset_id": step["source"], "reason": "missing_evidence_source", "step": index + 1})
            proof = confirmed.get((step["source"], step["target"]))
            step["confirmed"] = proof is not None
            if proof:
                step["confirmation"] = proof
            expected = "observed" if kind == "OBSERVED_CONNECTION" else "inferred"
            if step["confidence"] != expected:
                issues.append({"asset_id": step["source"], "reason": "evidence_semantics_mismatch", "step": index + 1})
            steps.append(step)
        for asset_id in asset_ids:
            hosts = {asset_id} if "Host" in nodes[asset_id].get("labels", []) else owners.get(asset_id, set())
            if not hosts:
                issues.append({"asset_id": asset_id, "reason": "unmanaged_or_unresolved_asset"})
            for host_id in sorted(hosts):
                agent_id = nodes[host_id]["properties"].get("agent_id", host_id)
                agent = agents.get(agent_id)
                if not agent:
                    issues.append({"asset_id": asset_id, "reason": "agent_health_unavailable"})
                    continue
                if agent.get("stale"):
                    issues.append({"asset_id": asset_id, "reason": "stale_agent"})
                if agent.get("needs_full"):
                    issues.append({"asset_id": asset_id, "reason": "snapshot_reconciliation_required"})
                gaps = agent.get("gaps") or []
                if isinstance(gaps, str):
                    try:
                        gaps = json.loads(gaps)
                    except ValueError:
                        gaps = [{"reason": "gap_metadata_unreadable"}]
                if gaps:
                    issues.append({"asset_id": asset_id, "reason": "collection_gaps", "gap_count": len(gaps)})
        path_id = hashlib.sha256(json.dumps([asset_ids, kinds], separators=(",", ":")).encode()).hexdigest()[:24]
        proven = sum(step["confirmed"] for step in steps)
        status = "proven" if proven == len(steps) else "partially_confirmed" if proven else "unvalidated"
        action = {"proven": "Every hop was reproduced on isolated replicas. Remediate the confirmed services, then re-test.",
                  "partially_confirmed": f"{proven} of {len(steps)} hops are confirmed. Validate the remaining hops in an isolated scenario.",
                  "unvalidated": "Validate every transition and its prerequisites in an isolated scenario."}[status]
        assessments.append({"id": path_id, "nodes": list(asset_ids), "hop_count": len(kinds), "steps": steps,
                            "validation_status": status, "confirmed_hops": proven, "telemetry_complete": not issues,
                            "issues": issues, "next_action": "Refresh or complete telemetry. " + action if issues else action})
    assessments.sort(key=lambda p: (p["hop_count"], len(p["issues"]), p["id"]))
    for rank, path in enumerate(assessments, 1):
        path["review_order"] = rank
    review = defaultdict(list)
    for path in assessments:
        for asset_id in path["nodes"][1:-1]:
            if asset_id not in entries and asset_id not in critical:
                review[asset_id].append(path["id"])
    points = [{"asset_id": k, "path_count": len(ids), "path_ids": sorted(ids),
               "label": str(nodes[k]["properties"].get("hostname") or k)} for k, ids in review.items()]
    points.sort(key=lambda p: (-p["path_count"], p["asset_id"]))
    preview = None
    if isolated_asset is not None:
        affected = [p["id"] for p in assessments if isolated_asset in p["nodes"]]
        preview = {"asset_id": isolated_asset, "affected_path_ids": affected,
                   "affected_count": len(affected), "remaining_count": len(assessments) - len(affected),
                   "scope": "Returned candidate paths only; assumes every traversal through this asset is removed.",
                   "limitation": "No configuration is changed. Real segmentation and legitimate workflows require separate validation."}
    return {"max_depth": max_depth, "paths": [p["steps"] for p in assessments], "assessments": assessments,
            "universe": {"entries": entries, "critical": critical, "path_count": len(assessments),
                         "proven_count": sum(p["validation_status"] == "proven" for p in assessments),
                         "max_paths": max_paths, "max_states": max_states, "max_hops": max_depth,
                         "topology_truncated": topology_truncated, "traversal_truncated": traversal_truncated,
                         "truncated": topology_truncated or traversal_truncated, "excluded_edges": dict(sorted(excluded.items())),
                         "generated_at": now.isoformat(), "freshness_threshold_seconds": stale_after_seconds,
                         "assumptions": assumptions},
            "ordering": "Shortest paths first, then fewer telemetry issues; review order is not exploit likelihood.",
            "warnings": warnings, "review_points": points, "isolation_preview": preview}
