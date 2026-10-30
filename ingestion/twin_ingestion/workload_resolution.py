"""Resolve observed socket endpoints only against unambiguous enrolled listeners."""
import ipaddress
import json
from collections import defaultdict


def resolve_workload_endpoints(snapshot):
    owners = defaultdict(set)
    hosts = {n["id"] for n in snapshot["nodes"] if "Host" in n.get("labels", [])}
    for edge in snapshot["edges"]:
        if edge["kind"] == "HAS_LISTENER" and edge["source"] in hosts:
            owners[edge["target"]].add(edge["source"])
    addresses = defaultdict(set)
    for node in snapshot["nodes"]:
        if len(owners[node["id"]]) != 1:
            continue
        try:
            data = json.loads(node["properties"].get("data_json", "{}"))
            # Only the workload collector exports these independently observed bindings.
            if node["properties"].get("evidence_source") != "workload:local-listener-and-interfaces":
                continue
            port = int(data["port"])
            if not 1 <= port <= 65535:
                continue
            for value in data["addresses"]:
                ip = ipaddress.ip_address(value)
                if ip.is_loopback or ip.is_unspecified:
                    continue
                addresses[f"endpoint:{ip}:{port}"].update(owners[node["id"]])
        except (ValueError, TypeError, KeyError):
            continue
    resolved = []
    seen = set()
    for edge in snapshot["edges"]:
        targets = addresses.get(edge["target"], set())
        if edge["kind"] != "OBSERVED_CONNECTION" or edge["source"] not in hosts or len(targets) != 1:
            continue
        target = next(iter(targets))
        key = (edge["source"], target)
        if target == edge["source"] or key in seen:
            continue
        seen.add(key)
        resolved.append({**edge, "target": target, "properties": {**edge.get("properties", {}),
            "resolved_endpoint": edge["target"], "resolution": "unique_enrolled_workload_listener"}})
    return {**snapshot, "edges": [*snapshot["edges"], *resolved]}
