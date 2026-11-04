import hashlib
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from twin_ingestion.api import EventHub, create_app
from twin_ingestion.settings import Settings
from twin_ingestion.security import AuthManager, access_rule


def test_saas_billing_route_roles():
    assert access_rule("GET", "/api/platform/tenants/acme/billing")[1] == "platform"
    assert access_rule("GET", "/api/billing")[1] == "viewer"
    assert access_rule("POST", "/api/billing/demo-checkout")[1] == "admin"

TOKENS = {role: f"synthetic-{role}-" + "x" * 48 for role in ("viewer", "operator", "admin")}


class Audit:
    def __init__(self):
        self.rows = []
        self.fail = None

    async def record(self, request_id, actor, role, action, stage, status=None, tenant=""):
        if stage == self.fail:
            raise RuntimeError("unavailable")
        self.rows.append(dict(request_id=str(request_id), actor=actor, role=role, action=action, stage=stage,
                              status=status, tenant_id=tenant))

    async def recent(self, tenant, limit):
        return [row for row in self.rows if row["tenant_id"] == tenant][-limit:]

    async def ready(self):
        if self.fail:
            raise RuntimeError()


class Graph:
    def __init__(self):
        self.changed = 0
        self.driver = SimpleNamespace(verify_connectivity=self.ready)

    async def ready(self):
        pass

    async def topology(self, tenant):
        return {"nodes": [], "edges": []}

    async def classify(self, *args):
        self.changed += 1
        return True


class History:
    def __init__(self):
        self.pool = SimpleNamespace(fetchval=self.ready)

    async def ready(self, query):
        return 1

    async def inventory(self, *args):
        return []


@pytest.fixture
def setup(tmp_path):
    auth_file = tmp_path / "auth.json"
    rows = [{"id": role, "role": role, "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
             "expires_at": "2099-01-01T00:00:00Z"} for role, token in TOKENS.items()]
    auth_file.write_text(json.dumps({"version": 1, "principals": rows}))
    settings = Settings(auth_mode="tokens", auth_file=str(auth_file), allowed_origins="https://testserver", cookie_secure=True)
    audit, graph = Audit(), Graph()
    app = create_app(settings, History(), graph, EventHub(), audit=audit)
    return settings, audit, graph, TestClient(app, base_url="https://testserver")


def bearer(role):
    return {"Authorization": "Bearer " + TOKENS[role]}


def test_roles_and_legacy_token_cannot_bypass(setup):
    _, audit, graph, client = setup
    assert client.get("/api/topology").status_code == 401
    assert client.get("/api/topology", headers={"X-Emulation-Token": "old"}).status_code == 401
    assert client.get("/api/topology", headers=bearer("viewer")).status_code == 200
    assert client.put("/api/assets/host:a/classification", headers=bearer("viewer"), json={"entry": True}).status_code == 403
    assert graph.changed == 0
    assert client.put("/api/assets/host:a/classification", headers=bearer("operator"), json={"entry": True}).status_code == 200
    assert graph.changed == 1
    assert client.get("/api/admin/audit", headers=bearer("operator")).status_code == 403
    assert client.get("/api/admin/audit", headers=bearer("admin")).status_code == 200
    assert {row["stage"] for row in audit.rows} == {"intent", "outcome", "denied"}
    assert all(token not in json.dumps(audit.rows) for token in TOKENS.values())


def test_browser_session_csrf_rotation_logout(setup):
    _, _, graph, client = setup
    origin = {"Origin": "https://testserver"}
    login = client.post("/api/auth/login", json={"token": TOKENS["operator"]}, headers=origin)
    assert login.status_code == 200
    cookie = login.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=strict" in cookie
    assert client.get("/api/topology").status_code == 200
    path = "/api/assets/host:a/classification"
    assert client.put(path, json={}).status_code == 403
    assert client.put(path, json={}, headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert graph.changed == 0
    assert client.put(path, json={}, headers=origin).status_code == 200
    assert client.post("/api/auth/logout", headers=origin).status_code == 200
    assert client.get("/api/topology").status_code == 401


def test_revocation_and_expiry_invalidate_sessions(setup):
    settings, _, _, client = setup
    assert client.post("/api/auth/login", json={"token": TOKENS["viewer"]}).status_code == 200
    from pathlib import Path
    path = Path(settings.auth_file)
    data = json.loads(path.read_text())
    data["principals"][0]["expires_at"] = "2000-01-01T00:00:00Z"
    path.write_text(json.dumps(data))
    assert client.get("/api/topology").status_code == 401
    assert client.get("/api/topology", headers=bearer("viewer")).status_code == 401


def test_audit_fail_closed_and_outcome_uncertainty(setup):
    _, audit, graph, client = setup
    audit.fail = "intent"
    r = client.put("/api/assets/a/classification", json={}, headers=bearer("operator"))
    assert r.status_code == 503 and graph.changed == 0
    audit.fail = "outcome"
    r = client.put("/api/assets/a/classification", json={}, headers=bearer("operator"))
    assert r.status_code == 503 and graph.changed == 1
    assert "reconcile" in r.text and r.headers["X-Request-ID"]


def test_validation_body_limits_rate_and_budget(setup):
    settings, audit, graph, client = setup
    seed = "seeded-secret-must-not-echo"
    r = client.put("/api/assets/a/classification", json={"entry": seed}, headers=bearer("operator"))
    assert r.status_code == 422 and seed not in r.text
    r = client.post("/api/emulation/plans", json={"cpu_budget_millis": 3000}, headers=bearer("operator"))
    assert r.status_code == 400
    bounded = replace(settings, max_body_bytes=1024, request_limit_per_minute=3)
    client = TestClient(create_app(bounded, History(), graph, EventHub(), audit=audit), base_url="https://testserver")
    r = client.put("/api/assets/a/classification", content=iter([b"x"*800, b"y"*800]), headers=bearer("operator"))
    assert r.status_code == 413
    for _ in range(3):
        assert client.get("/api/topology", headers=bearer("viewer")).status_code == 200
    assert client.get("/api/topology", headers=bearer("viewer")).status_code == 429


def test_startup_readiness_and_bad_manifest(setup):
    settings, audit, _, client = setup
    assert client.get("/readyz").status_code == 200
    audit.fail = "ready"
    assert client.get("/readyz").status_code == 503
    with pytest.raises(ValueError):
        AuthManager(replace(settings, deployment_mode="company", cookie_secure=False))
    with pytest.raises(ValueError):
        AuthManager(replace(settings, deployment_mode="company"))  # Default DB passwords.
    with pytest.raises(RuntimeError):
        AuthManager(replace(settings, auth_file="missing-test-auth-file"))
    with pytest.raises(ValueError):
        create_app(settings, History(), Graph(), EventHub())  # No audit storage.
