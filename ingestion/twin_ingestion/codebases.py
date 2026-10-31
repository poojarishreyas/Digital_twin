"""Pinned, tenant-scoped GitHub source and a bounded repair for the supplied lab.

Repository content is read as data, never imported, executed or followed as instructions.
Only the exact supplied app/auth snapshots are eligible for the deterministic repair.
"""
import asyncio
import base64
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request as URLRequest, build_opener, HTTPRedirectHandler

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

LAB = Path(__file__).with_name("codebase_lab")
VULNERABLE = '''def list_orders(headers):
    # VULNERABILITY: caller identity and order ownership are not checked.
    return 200, {"orders": ORDERS}'''
REPAIRED = '''def list_orders(headers):
    principal = authenticate(headers)
    if principal is None:
        return 401, {"error": "authentication required"}
    if principal["role"] == "support":
        return 200, {"orders": ORDERS}
    owned = [order for order in ORDERS if order["customer_id"] == principal["customer_id"]]
    return 200, {"orders": owned}'''


def baseline():
    return (LAB / "app.py").read_text(encoding="utf-8").replace("\r\n", "\n")


def repaired_source():
    return baseline().replace(VULNERABLE, REPAIRED)


def normalize_repository(url):
    value = urlsplit(url.strip())
    if (value.scheme != "https" or value.netloc.lower() != "github.com" or value.query or value.fragment
            or not re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}/?", value.path)):
        raise ValueError("Enter a repository root URL such as https://github.com/owner/repository")
    slug = value.path.strip("/").removesuffix(".git")
    if slug.split("/")[1] in {".", ".."}:
        raise ValueError("Invalid repository name")
    return "https://github.com/" + slug, slug


class GitHubError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class GitHub:
    def request(self, method, path, token=None, body=None):
        if not path.startswith("/repos/"):
            raise ValueError("GitHub path is outside repository scope")
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "DigitalTwin-Codebase/1"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = URLRequest("https://api.github.com" + path, headers=headers, method=method,
                             data=json.dumps(body).encode() if body is not None else None)
        try:
            with build_opener(NoRedirect).open(request, timeout=15) as response:
                raw = response.read(300_001)
            if len(raw) > 300_000:
                raise GitHubError(502, "Repository response exceeds the supported size")
            return json.loads(raw)
        except HTTPError as exc:
            messages = {401: "GitHub credentials are invalid", 403: "GitHub access denied or rate limit reached",
                        404: "Repository or supported lab files were not found; use a public repository or configure workspace access",
                        422: "GitHub rejected the branch or pull request operation"}
            raise GitHubError(exc.code, messages.get(exc.code, "GitHub request failed")) from None
        except (URLError, TimeoutError, ValueError):
            raise GitHubError(502, "GitHub is unavailable or returned an invalid response") from None

    def file(self, slug, path, commit, token):
        value = self.request("GET", f"/repos/{slug}/contents/{path}?{urlencode({'ref': commit})}", token)
        if not isinstance(value, dict) or value.get("type") != "file" or value.get("encoding") != "base64" or value.get("size", 100000) > 64000:
            raise GitHubError(422, "Only regular lab files under 64 KB are supported")
        try:
            return base64.b64decode(value["content"], validate=False).decode("utf-8").replace("\r\n", "\n"), value["sha"]
        except (KeyError, UnicodeError, ValueError):
            raise GitHubError(422, "Lab file content is invalid") from None


def workspace_token(tenant, slug):
    """Server-mounted credentials explicitly bind each token to tenant + repos."""
    path = Path(os.environ.get("TWIN_GITHUB_TOKENS_FILE", "/run/twin-auth/github.json"))
    if not path.exists():
        return None
    try:
        entry = json.loads(path.read_text(encoding="utf-8")).get(tenant, {})
        allowed = entry.get("repositories", [])
        token = entry.get("token", "")
        if not isinstance(allowed, list) or not isinstance(token, str):
            raise ValueError()
        return token if slug.lower() in {item.lower() for item in allowed if isinstance(item, str)} and token else None
    except (OSError, ValueError, AttributeError):
        raise GitHubError(503, "Workspace GitHub integration configuration is invalid") from None


def inspect_source(github, url, token=None):
    url, slug = normalize_repository(url)
    repository = github.request("GET", "/repos/" + slug, token)
    branch = repository["default_branch"]
    head = github.request("GET", f"/repos/{slug}/commits/{quote(branch, safe='')}", token)["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", head):
        raise GitHubError(502, "GitHub returned an invalid commit")
    manifest, _ = github.file(slug, "twinlab.json", head, token)
    try:
        if json.loads(manifest) != {"schema": "twinhunter.lab.v1", "scenario": "order-history-auth", "entrypoint": "app.py"}:
            raise ValueError()
    except ValueError:
        raise GitHubError(422, "This repository is not the supported Larkspur order-history lab") from None
    source, file_sha = github.file(slug, "app.py", head, token)
    auth, _ = github.file(slug, "auth.py", head, token)
    expected_auth = (LAB / "auth.py").read_text(encoding="utf-8").replace("\r\n", "\n")
    if source not in {baseline(), repaired_source()} or auth != expected_auth:
        raise GitHubError(422, "Source differs from the supported lab snapshot; no automatic repair will be made")
    vulnerable = source == baseline()
    patch = "".join(difflib.unified_diff(source.splitlines(True), repaired_source().splitlines(True), fromfile="a/app.py", tofile="b/app.py"))
    return {"url": url, "slug": slug, "branch": branch, "commit": head, "file_sha": file_sha,
            "source_hash": hashlib.sha256(source.encode()).hexdigest(), "vulnerable": vulnerable,
            "status": "vulnerable" if vulnerable else "fixed", "scenario": "order-history-auth", "file": "app.py",
            "verified_at": datetime.now(timezone.utc).isoformat(), "diff": patch,
            "finding": "Unauthenticated order-history API exposes cross-customer orders" if vulnerable else None,
            "validation": "Pinned source compared with the supported fixture; repository code was not executed"}


def create_repair_pr(github, snapshot, token):
    """Re-read default branch, then change only the verified function on a new branch."""
    current = inspect_source(github, snapshot["url"], token)
    if current["commit"] != snapshot["commit"]:
        raise GitHubError(409, "Repository changed; refresh source and analyze the new commit before creating a fix")
    if not current["vulnerable"]:
        raise GitHubError(409, "The default branch already contains the supported repair")
    slug, base = current["slug"], current["branch"]
    branch = "twinhunter/order-auth-" + current["commit"][:16]
    head_owner = slug.split("/")[0]
    query = urlencode({"head": head_owner + ":" + branch, "base": base, "state": "all"})
    existing = github.request("GET", f"/repos/{slug}/pulls?{query}", token)
    if existing:
        pull = existing[0]
        if pull["state"] != "open":
            raise GitHubError(409, "The earlier repair PR is closed; review it on GitHub before retrying")
        return {"url": pull["html_url"], "number": pull["number"], "branch": branch, "status": "open", "base_commit": current["commit"]}
    try:
        github.request("POST", f"/repos/{slug}/git/refs", token, {"ref": "refs/heads/" + branch, "sha": current["commit"]})
    except GitHubError as exc:
        if exc.status != 422:
            raise
        # Resume a partial previous attempt without force-pushing or deleting.
        branch_source, _ = github.file(slug, "app.py", branch, token)
        if branch_source not in {baseline(), repaired_source()}:
            raise GitHubError(409, "Repair branch has unexpected changes; review it on GitHub") from None
    branch_source, branch_file_sha = github.file(slug, "app.py", branch, token)
    if branch_source == baseline():
        github.request("PUT", f"/repos/{slug}/contents/app.py", token, {
            "message": "Fix authentication and customer isolation in order history", "branch": branch,
            "sha": branch_file_sha, "content": base64.b64encode(repaired_source().encode()).decode()})
    elif branch_source != repaired_source():
        raise GitHubError(409, "Repair branch has unexpected changes")
    pull = github.request("POST", f"/repos/{slug}/pulls", token, {
        "title": "Fix unauthenticated access to customer order history", "head": branch, "base": base,
        "body": "The order-history handler returned all synthetic orders without authenticating the caller. This change rejects anonymous/invalid credentials and scopes customer responses to their own records while preserving support access.\n\nOnly app.py is changed. Source was matched to the supported fixture at commit " + current["commit"] + ". No repository code was executed by the control plane.\n\nValidation to run before merge: `python -m unittest test_security -v` (six tests). This PR is not merged automatically and does not deploy to AWS."})
    return {"url": pull["html_url"], "number": pull["number"], "branch": branch, "status": "open", "base_commit": current["commit"]}


class CodebaseStore:
    def __init__(self, pool):
        self.pool = pool

    async def ensure_schema(self):
        await self.pool.execute("""CREATE TABLE IF NOT EXISTS workspace_codebases(
          tenant_id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())""")

    async def get(self, tenant):
        value = await self.pool.fetchval("SELECT data FROM workspace_codebases WHERE tenant_id=$1", tenant)
        return json.loads(value) if isinstance(value, str) else value

    async def put(self, tenant, data):
        await self.pool.execute("""INSERT INTO workspace_codebases(tenant_id,data) VALUES($1,$2::jsonb)
          ON CONFLICT(tenant_id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()""", tenant, json.dumps(data))

    async def put_if_current(self, tenant, data, expected):
        result = await self.pool.execute("""UPDATE workspace_codebases SET data=$2::jsonb,updated_at=now()
          WHERE tenant_id=$1 AND data->>'slug'=$3 AND data->>'commit'=$4""",
          tenant, json.dumps(data), expected["slug"], expected["commit"])
        return result == "UPDATE 1"


class ConnectCodebase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=240)


class RepairCodebase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commit: str = Field(pattern=r"^[a-f0-9]{40}$")
    repository: str = Field(pattern=r"^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$", max_length=140)


def register_routes(app, store, tenant_of, github=None):
    github = github or GitHub()

    def available():
        if store is None:
            raise HTTPException(503, "Codebase storage unavailable")
        return store

    def public(tenant, data):
        return {"codebase": data, "pr_enabled": bool(data and workspace_token(tenant, data["slug"]))}

    async def remote(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except GitHubError as exc:
            raise HTTPException(exc.status if exc.status in {409, 422, 503} else 502, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @app.get("/api/codebase")
    async def get(request: Request):
        tenant = tenant_of(request)
        return public(tenant, await available().get(tenant))

    @app.put("/api/codebase")
    async def connect(body: ConnectCodebase, request: Request):
        tenant = tenant_of(request)
        try:
            _, slug = normalize_repository(body.url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        data = await remote(inspect_source, github, body.url, workspace_token(tenant, slug))
        await available().put(tenant, data)
        return public(tenant, data)

    @app.post("/api/codebase/refresh")
    async def refresh(request: Request):
        tenant = tenant_of(request)
        previous = await available().get(tenant)
        if previous is None:
            raise HTTPException(409, "Add a codebase before starting analysis")
        data = await remote(inspect_source, github, previous["url"], workspace_token(tenant, previous["slug"]))
        if previous.get("pr") and data["vulnerable"]:
            data["pr"] = previous["pr"]
        if not await available().put_if_current(tenant, data, previous):
            raise HTTPException(409, "Codebase changed during refresh; reload and try again")
        return public(tenant, data)

    @app.post("/api/codebase/repair")
    async def repair(body: RepairCodebase, request: Request):
        tenant = tenant_of(request)
        data = await available().get(tenant)
        if data is None:
            raise HTTPException(409, "Add a codebase before creating a repair")
        if body.commit != data["commit"] or body.repository != data["slug"]:
            raise HTTPException(409, "Source selection changed; analyze the current commit")
        token = workspace_token(tenant, data["slug"])
        if not token:
            raise HTTPException(409, "GitHub write access is not connected for this workspace and repository")
        pull = await remote(create_repair_pr, github, data, token)
        updated = {**data, "pr": pull}
        if not await available().put_if_current(tenant, updated, data):
            raise HTTPException(409, "Codebase selection changed. Review the created PR at " + pull["url"])
        return public(tenant, updated)
