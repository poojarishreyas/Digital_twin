"""Promote executed sandbox findings to CONFIRMED_ATTACK_TRANSITION edges.

A hop X -> H is confirmed only with both halves of the evidence:
  * the agent on X observed a connection to H on the port of a specific service, and
  * an isolated replica of that same service reproduced a weakness (verdict "confirmed").
A whole-chain scenario that the sandbox confirmed also confirms each of its hops.
Model statements, reachability alone, or a weakness on a different port never qualify.
"""
from __future__ import annotations

import ipaddress
import json
from collections import defaultdict

KIND = "CONFIRMED_ATTACK_TRANSITION"
LIVE = frozenset({"OBSERVED_CONNECTION", "INFERRED_REACHABILITY"})
CHAIN_TEST = "scenario.http_chain"
# Process names that identify a service family's listening socket in the agent's `ss` output.
PROCESS = {"nginx": ("nginx",), "postgresql": ("postgres",), "redis": ("redis",), "openssh": ("sshd",)}


def _data(node):
    try:
        return json.loads(node.get("properties", {}).get("data_json") or "{}")
    except (TypeError, ValueError):
        return {}


def _endpoint(target):
    """endpoint:IP:PORT -> (ip, port); None for anything else."""
    if not str(target).startswith("endpoint:"):
        return None
    host, _, port = str(target)[len("endpoint:"):].rpartition(":")
    try:
        return str(ipaddress.ip_address(host.strip("[]"))), int(port)
    except ValueError:
        return None


def _family(name):
    name = str(name).lower()
    return next((family for family in PROCESS if family in name or
                 (family == "openssh" and name in {"ssh", "sshd"}) or
                 (family == "postgresql" and name.startswith("postgres"))), None)


def confirmed_transitions(topology: dict, detail: dict) -> list[dict]:
    """Return confirmed hops for one emulation run detail against the current tenant topology."""
    nodes = {n["id"]: n for n in topology.get("nodes", [])}
    hosts = {i for i, n in nodes.items() if "Host" in n.get("labels", [])}
    owner, ports, addresses = {}, defaultdict(lambda: defaultdict(set)), {}
    for edge in topology.get("edges", []):
        source, target = edge["source"], edge["target"]
        if source not in hosts or target not in nodes:
            continue
        if edge["kind"] == "HAS_SERVICE":
            owner[target] = source
        elif edge["kind"] == "HAS_LISTENER":
            data = _data(nodes[target])
            for ip in data.get("addresses") or []:
                addresses.setdefault(str(ip), set()).add(source)
            local, process = str(data.get("local", "")), str(data.get("process", "")).lower()
            try:
                port = int(local.rpartition(":")[2]) if local else int(data.get("port", 0))
            except ValueError:
                continue
            for family, names in PROCESS.items():
                if any(name in process for name in names):
                    ports[source][family].add(port)
    run_id = str(detail.get("run", {}).get("id", ""))
    vulnerable = defaultdict(list)  # (host, port) -> confirmed service findings
    for finding in detail.get("findings", []):
        if finding.get("verdict") != "confirmed" or finding.get("test_id") == CHAIN_TEST:
            continue
        service = finding.get("target_id")
        host = owner.get(service)
        family = _family(_data(nodes.get(service, {})).get("name", ""))
        if host is None or family is None:
            continue
        for port in ports[host][family]:
            vulnerable[(host, port)].append(finding)

    hops = {}

    def add(source, target, basis, finding_ids=(), test_ids=(), port=None):
        hop = hops.setdefault((source, target), {"source": source, "target": target, "kind": KIND, "properties": {
            "run_id": run_id, "basis": [], "finding_ids": [], "test_ids": [], "ports": []}})
        props = hop["properties"]
        for key, values in (("basis", [basis]), ("finding_ids", finding_ids), ("test_ids", test_ids),
                            ("ports", [port] if port is not None else [])):
            props[key] = sorted(set(props[key]) | {str(v) if key != "ports" else v for v in values})

    for edge in topology.get("edges", []):
        if edge["kind"] != "OBSERVED_CONNECTION" or edge["source"] not in hosts:
            continue
        parsed = _endpoint(edge["target"])
        if parsed is None:
            continue
        ip, port = parsed
        owners = addresses.get(ip, set())
        if len(owners) != 1:
            continue  # Unknown or ambiguous address: never guess which host was reached.
        target = next(iter(owners))
        if target == edge["source"] or (target, port) not in vulnerable:
            continue
        found = vulnerable[(target, port)]
        add(edge["source"], target, "observed_connection_to_confirmed_service",
            [f.get("id", "") for f in found], [f.get("test_id", "") for f in found], port)

    validated = set(detail.get("validated_path_ids", []))
    for path in detail.get("run", {}).get("plan", {}).get("paths", []):
        if path.get("id") in validated:
            route = list(path.get("nodes", []))
            if len(route) < 2 or not all(n in hosts for n in route):
                continue  # Only host-to-host chains; never bridge over an unresolved hop.
            for source, target in zip(route, route[1:]):
                add(source, target, "confirmed_chain_scenario", test_ids=[CHAIN_TEST])
    return sorted(hops.values(), key=lambda h: (h["source"], h["target"]))
