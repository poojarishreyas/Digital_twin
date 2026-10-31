"""Sandbox findings upgrade observed hops to confirmed ones; nothing else can."""
import json
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from twin_ingestion.api import EventHub, create_app
from twin_ingestion.confirmation import confirmed_transitions
from twin_ingestion.path_analysis import analyze_paths
from twin_ingestion.settings import Settings
from test_tenancy import manifest, TOKENS, History, Audit

NOW = datetime(2026, 10, 31, 12, tzinfo=timezone.utc)
IPS = {"web": "10.30.1.10", "app": "10.30.2.85", "db": "10.30.2.50"}


def host(name, **flags):
    return {"id": name, "labels": ["Asset", "Host"], "properties": {"agent_id": name, "hostname": name, **flags}}


def component(identifier, data, source="ss"):
    return {"id": identifier, "labels": ["Asset", "Component"], "properties": {
        "kind": identifier.split(":")[0], "data_json": json.dumps(data), "evidence_source": source}}


def link(source, target, kind="OBSERVED_CONNECTION", **props):
    return {"source": source, "target": target, "kind": kind, "properties": {
        "observed_at": NOW.isoformat(), "evidence_source": "ss", "confidence": "observed", **props}}


def store():
    """Larkspur-like twin: web -> app (catalog 8081, redis 6379) -> db (postgres 5432)."""
    nodes = [host("web", entry=True), host("app"), host("db", critical=True)]
    edges = []
    for name, service, port, process in (("web", "nginx", 80, "nginx"), ("app", "redis6", 6379, "redis-server"),
                                         ("db", "postgresql", 5432, "postgres")):
        nodes += [component(f"service:{name}:{service}", {"name": service}, "systemd"),
                  component(f"listener:{name}:tcp:0.0.0.0:{port}", {"local": f"0.0.0.0:{port}",
                            "process": f'users:(("{process}",pid=1))'}),
                  component(f"listener:{name}:workload", {"port": port, "addresses": [IPS[name]]},
                            "workload:local-listener-and-interfaces")]
        edges += [link(name, f"service:{name}:{service}", "HAS_SERVICE"),
                  link(name, f"listener:{name}:tcp:0.0.0.0:{port}", "HAS_LISTENER"),
                  link(name, f"listener:{name}:workload", "HAS_LISTENER")]
    edges += [link("web", f"endpoint:{IPS['app']}:8081"), link("app", f"endpoint:{IPS['db']}:5432")]
    return {"nodes": nodes, "edges": edges}


def run(findings, validated=(), paths=(), status="completed"):
    return {"run": {"id": "run-1", "status": status, "plan": {"paths": list(paths)}},
            "findings": findings, "validated_path_ids": list(validated)}


def finding(target, verdict="confirmed", test="redis.unauthenticated"):
    return {"id": "f-" + target, "target_id": target, "verdict": verdict, "test_id": test}


def test_confirmed_service_reached_on_its_own_port_confirms_the_hop():
    topology = store()
    topology["edges"].append(link("web", f"endpoint:{IPS['app']}:6379"))
    hops = confirmed_transitions(topology, run([finding("service:app:redis6")]))
    assert [(h["source"], h["target"]) for h in hops] == [("web", "app")]
    props = hops[0]["properties"]
    assert props["ports"] == [6379] and props["basis"] == ["observed_connection_to_confirmed_service"]
    assert props["finding_ids"] == ["f-service:app:redis6"] and hops[0]["kind"] == "CONFIRMED_ATTACK_TRANSITION"


def test_weakness_on_a_port_the_source_never_reached_confirms_nothing():
    # web only talks to the catalog on 8081; a confirmed Redis weakness on 6379 is not that hop.
    assert confirmed_transitions(store(), run([finding("service:app:redis6")])) == []


def test_unconfirmed_verdicts_and_unknown_services_confirm_nothing():
    topology = store()
    topology["edges"].append(link("web", f"endpoint:{IPS['app']}:6379"))
    for verdict in ("not_reproduced", "inconclusive", "unsupported"):
        assert confirmed_transitions(topology, run([finding("service:app:redis6", verdict)])) == []
    assert confirmed_transitions(topology, run([finding("service:elsewhere:redis6")])) == []


def test_ambiguous_address_is_never_attributed_to_a_host():
    topology = store()
    topology["edges"].append(link("web", f"endpoint:{IPS['app']}:6379"))
    topology["nodes"].append(component("listener:db:workload2", {"port": 9, "addresses": [IPS["app"]]},
                                       "workload:local-listener-and-interfaces"))
    topology["edges"].append(link("db", "listener:db:workload2", "HAS_LISTENER"))
    assert confirmed_transitions(topology, run([finding("service:app:redis6")])) == []


def test_confirmed_chain_scenario_confirms_each_host_hop_only():
    paths = [{"id": "p1", "nodes": ["web", "app", "db"]}, {"id": "p2", "nodes": ["web", "endpoint:1.2.3.4:80", "db"]}]
    hops = confirmed_transitions(store(), run([], validated=["p1", "p2"], paths=paths))
    assert [(h["source"], h["target"]) for h in hops] == [("app", "db"), ("web", "app")]
    assert all(h["properties"]["basis"] == ["confirmed_chain_scenario"] for h in hops)
    assert confirmed_transitions(store(), run([], validated=[], paths=paths)) == []


def path_topology(*confirmed):
    topology = {"nodes": [host("web", entry=True), host("app"), host("db", critical=True)],
                "edges": [link("web", "app"), link("app", "db")]}
    for source, target in confirmed:
        topology["edges"].append({"source": source, "target": target, "kind": "CONFIRMED_ATTACK_TRANSITION",
                                  "properties": {"observed_at": NOW.isoformat(), "evidence_source": "sandbox:run-1",
                                                 "confidence": "confirmed",
                                                 "properties_json": json.dumps({"basis": ["confirmed_chain_scenario"], "run_id": "run-1"})}})
    agents = [{"agent_id": n, "stale": False, "needs_full": False, "gaps": []} for n in ("web", "app", "db")]
    return topology, agents


def test_paths_report_unvalidated_partial_and_proven_hops():
    statuses = {}
    for label, confirmed in (("none", ()), ("one", (("web", "app"),)), ("all", (("web", "app"), ("app", "db")))):
        result = analyze_paths(*path_topology(*confirmed), now=NOW)
        path = result["assessments"][0]
        statuses[label] = (path["validation_status"], path["confirmed_hops"], result["universe"]["proven_count"])
    assert statuses == {"none": ("unvalidated", 0, 0), "one": ("partially_confirmed", 1, 0), "all": ("proven", 2, 1)}
    proven = analyze_paths(*path_topology(("web", "app"), ("app", "db")), now=NOW)["assessments"][0]
    assert proven["steps"][0]["confirmation"]["run_id"] == "run-1"
    assert proven["steps"][0]["kind"] == "OBSERVED_CONNECTION"  # The route itself still comes from observation.


def test_confirmed_edge_alone_never_creates_a_route():
    topology, agents = path_topology(("web", "db"))
    topology["edges"] = [e for e in topology["edges"] if e["kind"] == "CONFIRMED_ATTACK_TRANSITION"]
    assert analyze_paths(topology, agents, now=NOW)["assessments"] == []


class Runs:
    def __init__(self, status="completed"):
        self.status = status

    async def detail(self, tenant, run_id):
        if tenant != "acme" or run_id != "run-1":
            return None
        return run([finding("service:app:redis6")], status=self.status)


class Graph:
    def __init__(self):
        self.written = []

    async def topology(self, tenant):
        topology = store()
        topology["edges"].append(link("web", f"endpoint:{IPS['app']}:6379"))
        return topology

    async def record_confirmations(self, tenant, transitions, recorded_at):
        self.written.append((tenant, [(h["source"], h["target"]) for h in transitions]))
        return len(transitions)


def client(tmp_path, status="completed"):
    auth_file = tmp_path / "auth.json"
    auth_file.write_text(json.dumps(manifest()))
    settings = Settings(auth_mode="tokens", auth_file=str(auth_file), allowed_origins="https://testserver", cookie_secure=True)
    graph = Graph()
    app = create_app(settings, History(), graph, EventHub(), runs=Runs(status), audit=Audit())
    return TestClient(app, base_url="https://testserver"), graph


def test_operator_promotes_own_completed_run_into_the_twin(tmp_path):
    api, graph = client(tmp_path)
    response = api.post("/api/emulation/runs/run-1/promote", headers={"Authorization": "Bearer " + TOKENS["alice"]})
    assert response.status_code == 200 and response.json()["written"] == 1
    assert graph.written == [("acme", [("web", "app")])]


def test_promotion_is_role_tenant_and_status_gated(tmp_path):
    api, graph = client(tmp_path)
    viewer = {"Authorization": "Bearer " + TOKENS["alice"], "X-Tenant": "globex"}
    assert api.post("/api/emulation/runs/run-1/promote", headers=viewer).status_code == 403
    foreign = {"Authorization": "Bearer " + TOKENS["bob"]}  # operator, but of globex
    assert api.post("/api/emulation/runs/run-1/promote", headers=foreign).status_code == 404
    assert graph.written == []
    api, graph = client(tmp_path, status="running")
    admin = {"Authorization": "Bearer " + TOKENS["alice"]}
    assert api.post("/api/emulation/runs/run-1/promote", headers=admin).status_code == 409
    assert graph.written == []
