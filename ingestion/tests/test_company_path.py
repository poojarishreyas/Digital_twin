"""Connected company admission, tool scope and repair evidence boundaries."""
import copy
import json
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient

from twin_ingestion.api import create_app, EventHub
from twin_ingestion.company.contracts import Artifact, discover
from twin_ingestion.company.verification import CompanyExecutor, security, workflows, verify_patch
from twin_ingestion.company.runtime import CompanyLab
from twin_ingestion.phase3.contracts import ACTION, Limits
from twin_ingestion.phase3.tools import Blocked
from twin_ingestion.phase3.hunter import hunt
from twin_ingestion.workload_resolution import resolve_workload_endpoints
from test_tenancy import manifest, TOKENS, History, Audit
from twin_ingestion.settings import Settings


def artifact():
    return Artifact(node_image="sha256:" + "a" * 64, database_image="sha256:" + "b" * 64,
        source_agents={role: "company-source-agent-" + role for role in ("employee", "gateway", "api", "database")})


def discovered():
    deployment = artifact()
    nodes, edges = [], []
    roles = list(deployment.source_agents)
    for i, (role, agent) in enumerate(deployment.source_agents.items()):
        props = {"last_seen": datetime.now(timezone.utc).isoformat()}
        nodes.append({"id": agent, "labels": ["Host"], "properties": props})
        for kind, name, data in (
            ("service", f"service:{agent}:company-{role}", {"version": "company-records/1.0.0",
              "image_id": deployment.database_image if role == "database" else deployment.node_image}),
            ("configuration", f"config:{agent}:workload", {"authorization": "authentication_only"}),
            ("listener", f"listener:{agent}:workload", {"port": 5432 if role == "database" else 8080,
                                                      "addresses": [f"172.24.0.{i+2}"]})):
            nodes.append({"id": name, "labels": ["Component"], "properties": {"kind": kind,
                "data_json": json.dumps(data), "hash": "c" * 64,
                "evidence_source": "workload:local-listener-and-interfaces" if kind == "listener" else "workload:deployment-declaration"}})
            if kind == "listener":
                edges.append({"source": agent, "target": name, "kind": "HAS_LISTENER", "properties": {}})
    for i, role in enumerate(roles[:-1]):
        target = f"endpoint:172.24.0.{i+3}:{5432 if i == 2 else 8080}"
        edges.append({"source": deployment.source_agents[role], "target": target,
                      "kind": "OBSERVED_CONNECTION", "properties": {"confidence": "observed"}})
    return {"nodes": nodes, "edges": edges, "truncated_nodes": False, "truncated_edges": False}


def test_observed_endpoints_join_the_complete_company_path():
    value = resolve_workload_endpoints(discovered())
    source = discover(artifact(), value)
    assert source["path"] == list(artifact().source_agents.values())
    assert not any(e["kind"] == "CONFIRMED_ATTACK_TRANSITION" for e in value["edges"])


def test_ambiguous_listener_mapping_does_not_invent_a_path():
    value = discovered()
    extra = copy.deepcopy(next(n for n in value["nodes"] if n["id"].startswith("listener:") and "gateway" in n["id"]))
    extra["id"] = "listener:another-agent:workload"
    value["nodes"].append(extra)
    value["nodes"].append({"id": "another-agent", "labels": ["Host"], "properties": {}})
    value["edges"].append({"source": "another-agent", "target": extra["id"], "kind": "HAS_LISTENER"})
    with pytest.raises(ValueError, match="complete observed"):
        discover(artifact(), resolve_workload_endpoints(value))


@pytest.mark.parametrize("change", ["stale", "image", "policy", "missing_link"])
def test_admission_refuses_stale_or_unfaithful_source(change):
    value = resolve_workload_endpoints(discovered())
    if change == "stale":
        value["nodes"][0]["properties"]["last_seen"] = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    elif change in {"image", "policy"}:
        node = next(n for n in value["nodes"] if n["id"] == (
            "service:company-source-agent-api:company-api" if change == "image" else "config:company-source-agent-api:workload"))
        data = json.loads(node["properties"]["data_json"])
        data["image_id" if change == "image" else "authorization"] = "wrong"
        node["properties"]["data_json"] = json.dumps(data)
    else:
        value["edges"] = [e for e in value["edges"] if not e.get("properties", {}).get("resolution")]
    with pytest.raises(ValueError):
        discover(artifact(), value)


@pytest.mark.parametrize("action", [
    {"name": "company_probe", "target_id": "gateway", "port": 8080, "operation": "http://production/"},
    {"name": "company_probe", "target_id": "gateway", "port": 8080, "operation": "restricted", "actor": "admin"},
    {"name": "company_patch", "target_id": "gateway", "port": 8080, "policy": "run-shell"},
])
def test_company_tools_cannot_choose_urls_admin_credentials_or_commands(action):
    with pytest.raises(ValidationError):
        ACTION.validate_python(action)


class Lab:
    tenant = "acme"
    target_id = "acme-job:gateway"
    policy = "authentication_only"

    def __init__(self, status=200, returned=True, correlated=True):
        self.status, self.returned, self.correlated, self.calls = status, returned, correlated, []

    def request(self, record, actor):
        self.calls.append((record, actor))
        return {"http_status": self.status, "returned_expected_record": self.returned,
                "chain_verified": self.correlated, "record": record, "actor": actor}


def test_foreign_tenant_target_is_blocked_before_any_request():
    lab = Lab()
    executor = CompanyExecutor(lab, {}, Limits(max_seconds=60))
    with pytest.raises(Blocked, match="registered"):
        executor.execute(ACTION.validate_python({"name": "company_probe", "target_id": "globex-job:gateway", "port": 8080, "operation": "restricted"}))
    assert not lab.calls and not executor.evidence


@pytest.mark.parametrize("status,returned,correlated,expected", [
    (200, True, True, "confirmed"), (200, True, False, "inconclusive"),
    (200, False, True, "inconclusive"), (403, False, True, "not_reproduced"),
    (503, False, False, "inconclusive"), (403, False, False, "inconclusive")])
def test_only_correlated_record_access_confirms_the_path(status, returned, correlated, expected):
    assert security(Lab(status, returned, correlated))["verdict"] == expected


def test_candidate_repair_requires_executed_evidence():
    lab = Lab()
    executor = CompanyExecutor(lab, {}, Limits(max_seconds=60))
    with pytest.raises(Blocked, match="executed"):
        executor.execute(ACTION.validate_python({"name": "company_patch", "target_id": lab.target_id, "port": 8080, "policy": "enforce_record_authorization"}))
    assert not lab.calls and not executor.patches


def test_application_outage_is_not_a_passing_legitimate_workflow():
    assert not workflows(Lab(503, False, False))["passed"]


def test_compromised_employee_config_has_no_admin_or_database_credentials():
    lab = object.__new__(CompanyLab)
    lab.tenant, lab.policy, lab.stage = "acme", "authentication_only", "source"
    lab.credentials = {name: "synthetic-private-" + name for name in ("employee", "admin", "database", "database_admin")}
    employee = json.dumps(lab.config("employee"))
    assert lab.credentials["employee"] in employee
    assert all(lab.credentials[name] not in employee for name in ("admin", "database", "database_admin"))
    gateway = json.dumps(lab.config("gateway"))
    assert all(secret not in gateway for secret in lab.credentials.values())


@pytest.mark.parametrize("configured,expected", [(None, 30), (60, 60)])
def test_company_can_wait_longer_without_changing_existing_model_deadline(configured, expected):
    class Model:
        identity = {"is_ai": False}
        def decide(self, messages, schema, tokens, timeout):
            assert timeout == expected
            return {"hypothesis": "Boundary test", "action": None, "stop": True}, {"total_tokens": 1}
    options = {} if configured is None else {"model_timeout_seconds": configured}
    result = hunt(Model(), SimpleNamespace(evidence=[], patches=[]), {}, Limits(max_seconds=120), **options)
    assert result["status"] == "completed"


def test_model_deadline_cannot_be_unbounded():
    with pytest.raises(ValueError, match="deadline"):
        hunt(None, None, {}, Limits(), model_timeout_seconds=600)


def test_verified_executor_result_stops_without_another_model_request():
    tools = SimpleNamespace(evidence=[], patches=[])
    def execute(action):
        tools.patches.append({"label": "verified by trusted verifier"})
        return {"status": "verified"}
    tools.execute = execute
    class Model:
        identity = {"is_ai": False}
        calls = 0
        def decide(self, *args):
            self.calls += 1
            assert self.calls == 1, "unnecessary model request after executor completion"
            return {"hypothesis": "Request verification", "action": {"name": "company_patch", "target_id": "gateway",
                    "port": 8080, "policy": "enforce_record_authorization"}, "stop": False}, {"total_tokens": 1}
    result = hunt(Model(), tools, {}, Limits(), completion_check=lambda: bool(tools.patches))
    assert result["status"] == "completed"
    assert result["trace"][-1]["payload"]["completion_reason"] == "executor_completion_criteria"


class Store:
    def __init__(self):
        self.saved = {("acme", artifact().artifact_id): artifact()}
        self.queued = []

    async def artifact(self, tenant, identifier):
        return self.saved.get((tenant, identifier))

    async def artifacts(self, tenant):
        return [{"id": key[1]} for key in self.saved if key[0] == tenant]

    async def put_artifact(self, tenant, value):
        self.saved[(tenant, value.artifact_id)] = value
        return value.artifact_id

    async def queue(self, tenant, identifier, discovery, *limits):
        self.queued.append(tenant)
        return "00000000-0000-0000-0000-000000000001"

    async def recent(self, tenant):
        return []

    async def get(self, tenant, identifier):
        return {"id": identifier, "status": "completed"} if tenant == "acme" else None


def test_company_api_is_scoped_and_viewers_cannot_queue(tmp_path):
    auth_file = tmp_path / "auth.json"
    auth_file.write_text(json.dumps(manifest()))
    store = Store()
    class Graph:
        async def topology(self, tenant):
            return resolve_workload_endpoints(discovered())
    settings = Settings(auth_mode="tokens", auth_file=str(auth_file), allowed_origins="https://testserver", cookie_secure=True)
    client = TestClient(create_app(settings, History(), Graph(), EventHub(), audit=Audit(), company=store), base_url="https://testserver")
    headers = {"Authorization": "Bearer " + TOKENS["alice"]}
    body = {"artifact_id": artifact().artifact_id}
    assert client.post("/api/company/runs", headers=headers, json=body).status_code == 202
    assert store.queued == ["acme"]
    foreign = {"Authorization": "Bearer " + TOKENS["bob"]}
    assert client.get("/api/company/artifacts", headers=foreign).json() == []
    assert client.post("/api/company/runs", headers=foreign, json=body).status_code == 404
    assert client.get("/api/company/runs/00000000-0000-0000-0000-000000000001", headers=foreign).status_code == 404
    viewer = {**headers, "X-Tenant": "globex"}
    assert client.post("/api/company/runs", headers=viewer, json=body).status_code == 403
    assert client.post("/api/company/artifacts", headers=viewer, json=artifact().model_dump()).status_code == 403
    assert client.post("/api/company/runs", headers=headers, json={**body, "tenant_id": "globex"}).status_code == 422
    assert store.queued == ["acme"]
