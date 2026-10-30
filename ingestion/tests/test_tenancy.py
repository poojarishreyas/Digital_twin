"""Tenant isolation: identity, sessions, per-tenant roles, agents, events, audit and ingestion."""
import asyncio
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from twin_ingestion.api import EventHub, create_app
from twin_ingestion.security import AuthManager
from twin_ingestion.settings import Settings

TOKENS = {name: f"synthetic-{name}-" + "t" * 48 for name in ("alice", "bob", "carol")}
ORIGIN = {"Origin": "https://testserver"}


def manifest():
    digest = lambda name: hashlib.sha256(TOKENS[name].encode()).hexdigest()
    return {
        "version": 2,
        "tenants": [{"id": "acme", "name": "Acme Corp"}, {"id": "globex", "name": "Globex"},
                    {"id": "initech", "name": "Initech", "status": "suspended"}],
        "principals": [
            {"id": "alice", "token_sha256": digest("alice"), "expires_at": "2099-01-01T00:00:00Z",
             "memberships": [{"tenant": "acme", "role": "admin"}, {"tenant": "globex", "role": "viewer"}]},
            {"id": "bob", "token_sha256": digest("bob"), "expires_at": "2099-01-01T00:00:00Z",
             "memberships": [{"tenant": "globex", "role": "operator"}]},
            {"id": "carol", "token_sha256": digest("carol"), "expires_at": "2099-01-01T00:00:00Z",
             "memberships": [{"tenant": "initech", "role": "admin"}]},
        ],
        "agents": [{"id": "agent-acme-1", "tenant": "acme"}, {"id": "agent-globex-1", "tenant": "globex"},
                   {"id": "agent-initech-1", "tenant": "initech"}],
    }


class Audit:
    def __init__(self):
        self.rows = []

    async def record(self, request_id, actor, role, action, stage, status=None, tenant=""):
        self.rows.append({"actor": actor, "action": action, "stage": stage, "tenant_id": tenant})

    async def recent(self, tenant, limit):
        return [row for row in self.rows if row["tenant_id"] == tenant][-limit:]

    async def ready(self):
        pass


class Graph:
    """Each tenant has a distinct, recognisable topology."""
    def __init__(self):
        self.calls = []
        self.driver = SimpleNamespace(verify_connectivity=self.ready)

    async def ready(self):
        pass

    async def topology(self, tenant):
        self.calls.append(tenant)
        return {"nodes": [{"id": f"host:{tenant}", "labels": ["Asset", "Host"], "properties": {}}], "edges": []}

    async def classify(self, tenant, asset_id, entry, critical):
        self.calls.append((tenant, asset_id))
        return asset_id == f"host:{tenant}"  # Another tenant's asset is not found.


class History:
    def __init__(self):
        self.pool = SimpleNamespace(fetchval=self.ready)

    async def ready(self, query):
        return 1

    async def inventory(self, tenant, stale):
        return []


@pytest.fixture
def env(tmp_path):
    auth_file = tmp_path / "auth.json"
    auth_file.write_text(json.dumps(manifest()))
    settings = Settings(auth_mode="tokens", auth_file=str(auth_file), allowed_origins="https://testserver",
                        cookie_secure=True, operator_tenant="acme")
    audit, graph = Audit(), Graph()
    client = TestClient(create_app(settings, History(), graph, EventHub(), audit=audit), base_url="https://testserver")
    return settings, audit, graph, client


def bearer(name, tenant=None):
    headers = {"Authorization": "Bearer " + TOKENS[name]}
    if tenant:
        headers["X-Tenant"] = tenant
    return headers


def test_bearer_requests_resolve_one_tenant(env):
    _, _, graph, client = env
    # Default is the first membership in sorted order.
    assert client.get("/api/topology", headers=bearer("alice")).json()["nodes"][0]["id"] == "host:acme"
    assert client.get("/api/topology", headers=bearer("alice", "globex")).json()["nodes"][0]["id"] == "host:globex"
    # No membership, malformed or suspended tenant: refused before any data access.
    calls = len(graph.calls)
    assert client.get("/api/topology", headers=bearer("bob", "acme")).status_code == 401
    assert client.get("/api/topology", headers=bearer("bob", "../acme")).status_code == 401
    assert client.get("/api/topology", headers=bearer("carol")).status_code == 401
    assert len(graph.calls) == calls


def test_roles_are_per_tenant(env):
    _, _, graph, client = env
    path = "/api/assets/host:acme/classification"
    assert client.put(path, json={"entry": True}, headers=bearer("alice", "acme")).status_code == 200
    # Admin in acme, viewer in globex.
    assert client.put("/api/assets/host:globex/classification", json={}, headers=bearer("alice", "globex")).status_code == 403
    # An operator cannot reach another tenant's asset by ID.
    assert client.put(path, json={}, headers=bearer("bob")).status_code == 404
    assert ("globex", "host:acme") in graph.calls
    assert client.get("/api/admin/audit", headers=bearer("alice", "globex")).status_code == 403


def test_session_switch_rotates_and_rebinds(env):
    _, _, _, client = env
    login = client.post("/api/auth/login", json={"token": TOKENS["alice"]}, headers=ORIGIN)
    assert login.status_code == 200
    body = login.json()
    assert body["tenant"] == "acme" and body["role"] == "admin"
    assert [t["id"] for t in body["tenants"]] == ["acme", "globex"]  # Suspended/foreign tenants never listed.
    old_cookie = client.cookies.get("twin_session")
    assert client.get("/api/topology").json()["nodes"][0]["id"] == "host:acme"
    # A header cannot move a cookie session; the session is dropped instead.
    assert client.get("/api/topology", headers={"X-Tenant": "globex"}).status_code == 401
    client.post("/api/auth/login", json={"token": TOKENS["alice"]}, headers=ORIGIN)
    assert client.post("/api/auth/tenant", json={"tenant": "initech"}, headers=ORIGIN).status_code == 403
    switched = client.post("/api/auth/tenant", json={"tenant": "globex"}, headers=ORIGIN)
    body = switched.json()
    assert switched.status_code == 200
    assert {k: body[k] for k in ("id", "role", "tenant", "auth_mode", "platform_admin", "kind")} == {
        "id": "alice", "role": "viewer", "tenant": "globex", "auth_mode": "tokens", "platform_admin": False, "kind": "token"}
    assert client.cookies.get("twin_session") != old_cookie
    assert client.get("/api/topology").json()["nodes"][0]["id"] == "host:globex"
    assert client.get("/api/tenant").json()["name"] == "Globex"


def test_membership_revocation_ends_session(env):
    settings, _, _, client = env
    client.post("/api/auth/login", json={"token": TOKENS["alice"], "tenant": "globex"}, headers=ORIGIN)
    assert client.get("/api/topology").status_code == 200
    data = manifest()
    data["principals"][0]["memberships"] = [{"tenant": "acme", "role": "admin"}]
    Path(settings.auth_file).write_text(json.dumps(data))
    assert client.get("/api/topology").status_code == 401


def test_audit_and_metrics_are_tenant_scoped(env):
    _, audit, _, client = env
    client.get("/api/topology", headers=bearer("bob"))
    client.get("/api/topology", headers=bearer("alice"))
    rows = client.get("/api/admin/audit", headers=bearer("alice")).json()
    assert rows and {row["tenant_id"] for row in rows} == {"acme"}
    assert any(row["actor"] == "bob" and row["tenant_id"] == "globex" for row in audit.rows)
    assert client.get("/metrics", headers=bearer("alice")).status_code == 200  # Operator tenant admin.


def test_agent_registry(env):
    settings, _, _, _ = env
    auth = AuthManager(settings)
    assert auth.agent_tenant("agent-acme-1") == "acme"
    assert auth.agent_tenant("agent-globex-1") == "globex"
    assert auth.agent_tenant("agent-initech-1") is None  # Suspended tenant.
    assert auth.agent_tenant("unregistered") is None  # Deny by default.
    data = manifest() | {"default_agent_tenant": "acme"}
    Path(settings.auth_file).write_text(json.dumps(data))
    assert auth.agent_tenant("unregistered") == "acme"
    for broken in (
        manifest() | {"agents": manifest()["agents"] + [{"id": "agent-acme-1", "tenant": "globex"}]},
        manifest() | {"default_agent_tenant": "missing"},
        manifest() | {"tenants": [{"id": "Bad Tenant"}]},
    ):
        Path(settings.auth_file).write_text(json.dumps(broken))
        with pytest.raises(RuntimeError):
            auth.manifest()


def test_v1_manifest_is_single_default_tenant(tmp_path):
    path = tmp_path / "auth.json"
    path.write_text(json.dumps({"version": 1, "principals": [{"id": "ops", "role": "operator", "expires_at": "2099-01-01T00:00:00Z",
                                                              "token_sha256": hashlib.sha256(TOKENS["bob"].encode()).hexdigest()}]}))
    auth = AuthManager(Settings(auth_mode="tokens", auth_file=str(path), allowed_origins="https://testserver"))
    principal = auth.token(TOKENS["bob"])
    assert (principal.tenant, principal.role) == ("default", "operator")
    assert auth.agent_tenant("any-legacy-agent") == "default"


def test_event_hub_partitions_tenants():
    hub = EventHub()

    async def run():
        acme, globex = asyncio.Queue(), asyncio.Queue()
        hub.listeners = {acme: "acme", globex: "globex"}
        await hub.publish("acme", {"type": "graph_updated"})
        return acme.qsize(), globex.qsize()
    assert asyncio.run(run()) == (1, 0)


def test_unregistered_agent_never_reaches_storage():
    from twin_ingestion.service import IngestionService

    class Validator:
        def validate(self, raw):
            data = json.loads(raw)
            return SimpleNamespace(agent_id=data["agent_id"], model_validate=lambda value: SimpleNamespace(agent_id=value["agent_id"])), data

    class Context:
        def auth_context(self):
            return {"x509_common_name": [b"rogue-agent"]}

    class Untouchable:
        def __getattr__(self, name):
            raise AssertionError("storage must not be called")

    service = IngestionService(Validator(), Untouchable(), Untouchable(), None, lambda agent: None)
    result = asyncio.run(service.sync(json.dumps({"agent_id": "rogue-agent"}).encode(), Context()))
    assert result["accepted_sequence"] == 0 and "tenant" in result["error"]
