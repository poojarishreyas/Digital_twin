import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from twin_ingestion.api import EventHub, create_app
from twin_ingestion.codebases import (LAB, GitHub, GitHubError, baseline, repaired_source,
    normalize_repository, inspect_source, create_repair_pr, workspace_token)
from test_tenancy import History, Graph, Audit, manifest, bearer
from twin_ingestion.settings import Settings

SHA = "a" * 40


class FakeGitHub:
    def __init__(self):
        self.head = SHA
        self.source = baseline()
        self.branch_source = self.source
        self.pulls = []
        self.writes = []
        self.read_refs = []

    def request(self, method, path, token=None, body=None):
        if method != "GET":
            self.writes.append((method, path, body))
        if method == "GET" and path == "/repos/example/lab":
            return {"default_branch": "main"}
        if method == "GET" and "/commits/" in path:
            return {"sha": self.head}
        if method == "GET" and "/pulls?" in path:
            return self.pulls
        if method == "POST" and path.endswith("/git/refs"):
            self.branch_source = self.source
            return {}
        if method == "PUT":
            assert body["branch"].startswith("twinhunter/")
            self.branch_source = base64.b64decode(body["content"]).decode()
            return {}
        if method == "POST" and path.endswith("/pulls"):
            self.pulls = [{"html_url": "https://github.com/example/lab/pull/1", "number": 1, "state": "open"}]
            return self.pulls[0]
        raise AssertionError((method, path))

    def file(self, slug, path, ref, token):
        self.read_refs.append(ref)
        if path == "app.py":
            return (self.branch_source if ref.startswith("twinhunter/") else self.source), "file-sha"
        return (LAB / path).read_text(encoding="utf-8").replace("\r\n", "\n"), "file-sha"


@pytest.mark.parametrize("url", ["http://github.com/a/b", "https://github.com.evil/a/b", "https://user@github.com/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b?token=x", "https://github.com/a/..", "https://127.0.0.1/a/b"])
def test_repository_urls_cannot_redirect_or_target_internal_hosts(url):
    with pytest.raises(ValueError):
        normalize_repository(url)


def test_pinned_source_and_idempotent_pr():
    github = FakeGitHub()
    source = inspect_source(github, "https://github.com/example/lab.git")
    assert source["commit"] == SHA and source["vulnerable"]
    assert set(github.read_refs) == {SHA}
    pull = create_repair_pr(github, source, "synthetic-token")
    assert pull["number"] == 1
    assert github.branch_source == repaired_source()
    assert github.source == baseline()  # Default branch is never written.
    writes = len(github.writes)
    assert create_repair_pr(github, source, "synthetic-token") == pull
    assert len(github.writes) == writes
    github.source = repaired_source()
    github.head = "b" * 40
    assert inspect_source(github, source["url"])["status"] == "fixed"


def test_changed_or_unsupported_source_is_not_patched():
    github = FakeGitHub()
    snapshot = inspect_source(github, "https://github.com/example/lab")
    github.head = "c" * 40
    with pytest.raises(GitHubError, match="changed"):
        create_repair_pr(github, snapshot, "synthetic-token")
    assert not github.writes
    github.source += "\n# unreviewed source\n"
    with pytest.raises(GitHubError, match="differs"):
        inspect_source(github, snapshot["url"])


def test_credential_scope_is_tenant_and_repository_bound(tmp_path, monkeypatch):
    config = tmp_path / "github.json"
    config.write_text(json.dumps({"acme": {"repositories": ["example/lab"], "token": "synthetic-token"}}))
    monkeypatch.setenv("TWIN_GITHUB_TOKENS_FILE", str(config))
    assert workspace_token("acme", "example/lab") == "synthetic-token"
    assert workspace_token("globex", "example/lab") is None
    assert workspace_token("acme", "other/lab") is None


def test_generated_repair_fixes_all_lab_security_tests(tmp_path):
    for name in ("auth.py", "test_security.py"):
        (tmp_path / name).write_text((LAB / name).read_text(encoding="utf-8"), encoding="utf-8")
    clean_env = {key: value for key, value in os.environ.items() if not key.startswith("LAB_")}
    (tmp_path / "app.py").write_text(baseline(), encoding="utf-8")
    vulnerable = subprocess.run([sys.executable, "-m", "unittest", "test_security", "-v"], cwd=tmp_path, env=clean_env, capture_output=True, text=True, timeout=20)
    assert vulnerable.returncode != 0 and "failures=5" in vulnerable.stderr
    (tmp_path / "app.py").write_text(repaired_source(), encoding="utf-8")
    # Avoid bytecode mtime collisions when replacing a fixture in the same second.
    fixed = subprocess.run([sys.executable, "-B", "-m", "unittest", "test_security", "-v"], cwd=tmp_path,
        env={**clean_env, "PYTHONPYCACHEPREFIX": str(tmp_path / "fixed-cache")}, capture_output=True, text=True, timeout=20)
    assert fixed.returncode == 0, fixed.stderr
    assert "Ran 6 tests" in fixed.stderr


class MemoryStore:
    def __init__(self): self.rows = {}
    async def get(self, tenant): return self.rows.get(tenant)
    async def put(self, tenant, data): self.rows[tenant] = data
    async def put_if_current(self, tenant, data, expected):
        current = self.rows.get(tenant)
        if not current or current["slug"] != expected["slug"] or current["commit"] != expected["commit"]:
            return False
        self.rows[tenant] = data
        return True


def test_api_blocks_missing_source_and_enforces_workspace_roles(tmp_path, monkeypatch):
    auth_file = tmp_path / "auth.json"
    auth_file.write_text(json.dumps(manifest()))
    monkeypatch.setenv("TWIN_GITHUB_TOKENS_FILE", str(tmp_path / "absent.json"))
    settings = Settings(auth_mode="tokens", auth_file=str(auth_file), allowed_origins="https://testserver", cookie_secure=True)
    store, github = MemoryStore(), FakeGitHub()
    client = TestClient(create_app(settings, History(), Graph(), EventHub(), audit=Audit(), codebases=store, github=github), base_url="https://testserver")
    assert client.get("/api/codebase").status_code == 401
    assert client.get("/api/paths", headers=bearer("alice")).status_code == 409
    assert client.put("/api/codebase", headers=bearer("bob"), json={"url": "https://github.com/example/lab"}).status_code == 403
    connected = client.put("/api/codebase", headers=bearer("alice"), json={"url": "https://github.com/example/lab"})
    assert connected.status_code == 200, connected.text
    assert not connected.json()["pr_enabled"]
    assert client.get("/api/paths", headers=bearer("alice")).status_code == 200
    assert client.get("/api/codebase", headers=bearer("bob")).json()["codebase"] is None
    assert client.post("/api/codebase/repair", headers=bearer("alice", "globex"), json={"commit": SHA, "repository": "example/lab"}).status_code == 403
    assert client.post("/api/codebase/repair", headers=bearer("alice"), json={"commit": SHA, "repository": "example/lab"}).status_code == 409
    assert not github.writes
    config = tmp_path / "github.json"
    config.write_text(json.dumps({"acme": {"repositories": ["example/lab"], "token": "synthetic-token"}}))
    monkeypatch.setenv("TWIN_GITHUB_TOKENS_FILE", str(config))
    wrong = client.post("/api/codebase/repair", headers=bearer("alice"), json={"commit": SHA, "repository": "other/lab"})
    assert wrong.status_code == 409 and not github.writes
    repaired = client.post("/api/codebase/repair", headers=bearer("alice"), json={"commit": SHA, "repository": "example/lab"})
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["codebase"]["pr"]["number"] == 1
    assert "synthetic-token" not in repaired.text
    assert repaired.json()["codebase"]["vulnerable"] is True
    github.source, github.head = repaired_source(), "b" * 40
    refreshed = client.post("/api/codebase/refresh", headers=bearer("alice"))
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["codebase"]["status"] == "fixed"
    assert "pr" not in refreshed.json()["codebase"]
