"""Bounded path universe and greedy path coverage planning."""
from __future__ import annotations

from dataclasses import dataclass, field
from collections import defaultdict, deque
from typing import Any

MAX_PATHS = 500
MAX_HOPS = 8
EDGE_KINDS = frozenset({"OBSERVED_CONNECTION", "INFERRED_REACHABILITY"})
PROBE_CPU_MILLIS = 200
PROBE_RAM_MB = 128


@dataclass(frozen=True)
class Service:
    id: str
    host_id: str
    kind: str
    version: str
    snapshot_hash: str
    directives: tuple[dict[str, Any], ...] = ()
    hba_rules: tuple[dict[str, Any], ...] = ()
    unsupported: tuple[str, ...] = ()
    cpu_millis: int = 250
    ram_mb: int = 256


@dataclass(frozen=True)
class Path:
    nodes: tuple[str, ...]
    edge_kinds: tuple[str, ...]
    services: frozenset[str]
    status: str = "untested"
    reason: str = ""

    @property
    def id(self) -> str:
        return self.nodes[0] + "|" + "|".join(f"{kind}:{target}" for kind, target in zip(self.edge_kinds, self.nodes[1:]))


@dataclass
class Wave:
    index: int
    service_ids: list[str]
    path_ids: list[str]
    cpu_millis: int
    ram_mb: int


@dataclass
class Plan:
    entries: list[str]
    critical: list[str]
    max_hops: int
    assumptions: list[str]
    paths: list[Path]
    waves: list[Wave]
    excluded: list[dict[str, str]]
    truncated: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "entries": self.entries, "critical": self.critical, "max_hops": self.max_hops,
            "assumptions": self.assumptions, "path_universe_size": len(self.paths),
            "planned_paths": sum(p.status == "planned" for p in self.paths),
            "untested_paths": sum(p.status != "planned" for p in self.paths),
            "paths": [{"id": p.id, "nodes": p.nodes, "edge_kinds": p.edge_kinds,
                       "services": sorted(p.services), "status": p.status, "reason": p.reason} for p in self.paths],
            "waves": [vars(w) for w in self.waves], "excluded": self.excluded, "truncated": self.truncated,
        }


def services_from_topology(topology: dict[str, Any]) -> list[Service]:
    """Map Phase 1 host-owned service/config records into supported twin inputs."""
    import json
    import hashlib
    from .adapters import CATALOG

    nodes = {n["id"]: n for n in topology["nodes"]}
    owned: dict[str, list[dict]] = defaultdict(list)
    for edge in topology["edges"]:
        if edge["kind"] in {"HAS_SERVICE", "HAS_CONFIGURATION"}:
            component = nodes.get(edge["target"])
            if component:
                owned[edge["source"]].append(component)
    result = []
    for host_id, components in owned.items():
        configs = []
        for component in components:
            props = component["properties"]
            if props.get("kind") == "configuration":
                configs.append((props, json.loads(props.get("data_json", "{}"))))
        for component in components:
            props = component["properties"]
            if props.get("kind") != "service":
                continue
            data = json.loads(props.get("data_json", "{}"))
            name = str(data.get("name", "")).lower()
            family = next((kind for kind in CATALOG if kind in name or
                           (kind == "openssh" and name in {"ssh", "sshd"}) or
                           (kind == "postgresql" and name.startswith("postgres"))), None)
            if family is None:
                continue
            matching = [(p, d) for p, d in configs if d.get("service") == family]
            if family == "postgresql":
                matching += [(p, d) for p, d in configs if d.get("service") == "pg_hba"]
            directives = tuple(d for p, c in matching if c.get("service") == family for d in c.get("directives", []))
            hba_rules = tuple(d for p, c in matching if c.get("service") == "pg_hba" for d in c.get("directives", []))
            unsupported = tuple(name for _, c in matching for name in c.get("unsupported_directives", []))
            if not any(c.get("service") == family for _, c in matching):
                unsupported += ("configuration_record_missing",)
            fingerprint = "|".join([props.get("hash", "")] + sorted(p.get("hash", "") for p, _ in matching))
            hash_id = hashlib.sha256(fingerprint.encode()).hexdigest()
            mapping = CATALOG[family]
            result.append(Service(component["id"], host_id, family, str(data.get("version", "")), hash_id,
                                  directives, hba_rules, unsupported, mapping["cpu_millis"], mapping["ram_mb"]))
    return sorted(result, key=lambda s: s.id)


def enumerate_paths(entries: list[str], critical: list[str], edges: list[dict], max_hops: int,
                    max_paths: int = MAX_PATHS, max_states: int = 10000) -> tuple[list[tuple[tuple[str, ...], tuple[str, ...]]], bool, list[dict]]:
    if not 1 <= max_hops <= MAX_HOPS:
        raise ValueError(f"max_hops must be between 1 and {MAX_HOPS}")
    if not entries or not critical:
        raise ValueError("explicit entry and critical endpoints are required")
    if not 1 <= max_paths <= MAX_PATHS or not 1 <= max_states <= 10000:
        raise ValueError("path and traversal budgets must be within 1..500 and 1..10000")
    adjacency_sets: dict[str, set[tuple[str, str]]] = defaultdict(set)
    excluded = []
    for edge in edges:
        if edge.get("kind") not in EDGE_KINDS:
            excluded.append({"id": f"{edge.get('source')}->{edge.get('target')}", "reason": "edge_kind_excluded"})
            continue
        adjacency_sets[edge["source"]].add((edge["target"], edge["kind"]))
    adjacency = {source: sorted(targets) for source, targets in adjacency_sets.items()}
    paths = []
    starts = sorted(set(entries))
    queue = deque((entry, (entry,), ()) for entry in starts[:max_states])
    targets = set(critical)
    truncated = len(starts) > max_states
    scheduled = len(queue)
    while queue:
        current, nodes, kinds = queue.popleft()
        if current in targets and len(nodes) > 1:
            if len(paths) == max_paths:
                truncated = True
                break
            paths.append((nodes, kinds))
            continue
        if len(kinds) >= max_hops:
            continue
        for target, kind in adjacency.get(current, []):
            if target not in nodes:
                if scheduled >= max_states:
                    truncated = True
                    break
                queue.append((target, nodes + (target,), kinds + (kind,)))
                scheduled += 1
    return paths, truncated, excluded


def plan(entries: list[str], critical: list[str], edges: list[dict], services: list[Service],
         max_hops: int = 4, cpu_budget_millis: int = 2000, ram_budget_mb: int = 4096,
         max_paths: int = MAX_PATHS) -> Plan:
    if cpu_budget_millis <= 0 or ram_budget_mb <= 0:
        raise ValueError("positive CPU and RAM budgets are required")
    raw_paths, truncated, excluded = enumerate_paths(entries, critical, edges, max_hops, max_paths)
    by_id = {s.id: s for s in services}
    by_host: dict[str, set[str]] = defaultdict(set)
    for service in services:
        by_host[service.host_id].add(service.id)
        by_host[service.id].add(service.id)
    paths = []
    for nodes, kinds in raw_paths:
        required = frozenset().union(*(by_host[n] for n in nodes))
        reason = "unsupported_or_missing_service_on_path" if any(not by_host[n] for n in nodes) else ""
        paths.append(Path(nodes, kinds, required, "untested", reason))

    # Each path is an indivisible bundle. A wave can cover additional paths whose
    # complete service bundle is a subset of the wave. This is greedy set coverage,
    # not a minimum vertex cut and not proof of exploitability.
    remaining = {p.id for p in paths if p.services and not p.reason}
    waves: list[Wave] = []
    while remaining:
        candidates = []
        for path in paths:
            if path.id not in remaining:
                continue
            cpu = PROBE_CPU_MILLIS + sum(by_id[s].cpu_millis for s in path.services)
            ram = PROBE_RAM_MB + sum(by_id[s].ram_mb for s in path.services)
            if cpu > cpu_budget_millis or ram > ram_budget_mb:
                continue
            covered = {p.id for p in paths if p.id in remaining and p.services <= path.services}
            score = len(covered) / max(1, cpu / cpu_budget_millis + ram / ram_budget_mb)
            candidates.append((-score, -len(covered), cpu + ram, path.id, path.services))
        if not candidates:
            break
        _, _, _, _, selected = min(candidates)
        covered = sorted(p.id for p in paths if p.id in remaining and p.services <= selected)
        remaining.difference_update(covered)
        waves.append(Wave(len(waves) + 1, sorted(selected), covered,
                          PROBE_CPU_MILLIS + sum(by_id[s].cpu_millis for s in selected),
                          PROBE_RAM_MB + sum(by_id[s].ram_mb for s in selected)))
    planned = {pid for w in waves for pid in w.path_ids}
    final = []
    for path in paths:
        if path.id in planned:
            final.append(Path(path.nodes, path.edge_kinds, path.services, "planned"))
        elif path.reason:
            final.append(path)
        else:
            final.append(Path(path.nodes, path.edge_kinds, path.services, "untested", "bundle_exceeds_budget"))
    return Plan(sorted(set(entries)), sorted(set(critical)), max_hops,
                ["Only directed observed or inferred edges are traversed.",
                 "A socket observation does not prove exploitability or other routes.",
                 "Each path requires all mapped service twins in the same wave.",
                 "Path enumeration stops at the configured cap; truncated state is excluded."],
                final, waves, excluded, truncated)

