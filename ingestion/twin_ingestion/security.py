"""Multi-tenant authentication, tenant-bound sessions and deny-by-default roles.

Every authenticated request resolves to exactly one tenant. Sessions are bound to
the tenant chosen at login or by an explicit switch, and memberships/roles are
re-read from the manifest on every request so revocation takes effect immediately.
Agents are mapped to tenants by certificate identity; unknown agents are refused
unless the manifest explicitly names a fallback tenant (single-company upgrade).
"""
import asyncio
from collections import OrderedDict, deque
from dataclasses import dataclass
from datetime import datetime
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit

from fastapi import HTTPException
from starlette.responses import JSONResponse

COOKIE = "twin_session"
ROLES = {"viewer": 0, "operator": 1, "admin": 2}
TENANT_PATTERN = r"[a-z0-9][a-z0-9-]{0,31}"
AGENT_PATTERN = r"[A-Za-z0-9_.:-]{1,128}"
DEFAULT_TENANT = "default"


@dataclass(frozen=True)
class Principal:
    id: str
    role: str
    fingerprint: str = ""
    tenant: str = DEFAULT_TENANT   # "" for a platform admin who belongs to no workspace
    tenants: tuple = ()  # ((tenant_id, name, role), ...) for the workspace switcher
    platform_admin: bool = False
    kind: str = "token"   # "token" (manifest credential) or "password" (database account)
    display_name: str = ""


@dataclass(frozen=True)
class Manifest:
    tenants: dict      # tenant_id -> {"id", "name", "status"}
    principals: dict   # principal_id -> {..., "expiry", "memberships": {tenant: role}}
    agents: dict       # agent_id -> tenant_id
    default_agent_tenant: str | None
    revoked_agents: frozenset = frozenset()


def _parse_v1(data):
    rows = data["principals"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ValueError()
    principals = {}
    for row in rows:
        if set(row) != {"id", "role", "token_sha256", "expires_at"} or row["role"] not in ROLES or row["id"] in principals:
            raise ValueError()
        principals[row["id"]] = {**row, "memberships": {DEFAULT_TENANT: row["role"]}}
    tenants = {DEFAULT_TENANT: {"id": DEFAULT_TENANT, "name": "Default workspace", "status": "active"}}
    return tenants, principals, {}, DEFAULT_TENANT


def _parse_v2(data):
    if set(data) - {"version", "tenants", "principals", "agents", "default_agent_tenant"}:
        raise ValueError()
    tenant_rows, rows, agent_rows = data["tenants"], data["principals"], data.get("agents", [])
    if not isinstance(tenant_rows, list) or not 1 <= len(tenant_rows) <= 500:
        raise ValueError()
    if not isinstance(rows, list) or not 1 <= len(rows) <= 5000 or not isinstance(agent_rows, list) or len(agent_rows) > 20000:
        raise ValueError()
    tenants = {}
    for row in tenant_rows:
        if set(row) - {"id", "name", "status"} or not re.fullmatch(TENANT_PATTERN, str(row.get("id", ""))):
            raise ValueError()
        name, status = row.get("name", row["id"]), row.get("status", "active")
        if not isinstance(name, str) or not 1 <= len(name) <= 80 or status not in {"active", "suspended"} or row["id"] in tenants:
            raise ValueError()
        tenants[row["id"]] = {"id": row["id"], "name": name, "status": status}
    principals = {}
    for row in rows:
        base = {"id", "token_sha256", "expires_at", "memberships"}
        if set(row) not in (base, base | {"platform_admin"}) or row["id"] in principals:
            raise ValueError()
        if not isinstance(row.get("platform_admin", False), bool):
            raise ValueError()
        memberships = row["memberships"]
        # Platform admins may operate the platform without belonging to any workspace.
        if not isinstance(memberships, list) or not (0 if row.get("platform_admin") else 1) <= len(memberships) <= 50:
            raise ValueError()
        roles = {}
        for item in memberships:
            if set(item) != {"tenant", "role"} or item["tenant"] not in tenants or item["role"] not in ROLES or item["tenant"] in roles:
                raise ValueError()
            roles[item["tenant"]] = item["role"]
        principals[row["id"]] = {**row, "memberships": roles}
    agents = {}
    for row in agent_rows:
        if set(row) != {"id", "tenant"} or row["tenant"] not in tenants or not re.fullmatch(AGENT_PATTERN, str(row["id"])):
            raise ValueError()
        if row["id"] in agents:
            raise ValueError()  # One agent identity can never report into two tenants.
        agents[row["id"]] = row["tenant"]
    fallback = data.get("default_agent_tenant")
    if fallback is not None and fallback not in tenants:
        raise ValueError()
    return tenants, principals, agents, fallback


class AuthManager:
    def __init__(self, settings, allow_missing_manifest: bool = False):
        self.settings = settings
        self.sessions = {}
        # A GUI-managed deployment may start with no manifest file at all: customers and
        # users then live in the database (see identity.py) and first-run setup creates
        # the platform admin.
        self.allow_missing_manifest = allow_missing_manifest
        self.directory = None
        self.origins = frozenset(s.strip() for s in settings.allowed_origins.split(",") if s.strip())
        if settings.auth_mode not in {"tokens", "lab"} or settings.deployment_mode not in {"local", "company"}:
            raise ValueError("invalid deployment/authentication mode")
        if not re.fullmatch(TENANT_PATTERN, settings.lab_tenant) or not re.fullmatch(TENANT_PATTERN, settings.operator_tenant):
            raise ValueError("invalid lab or operator tenant identifier")
        if not 60 <= settings.session_seconds <= 3600:
            raise ValueError("session duration must be between 60 and 3600 seconds")
        if not self.origins or any(urlsplit(s).scheme not in {"http", "https"} or not urlsplit(s).netloc
                                   or urlsplit(s).path or urlsplit(s).query or urlsplit(s).fragment
                                   or urlsplit(s).username or urlsplit(s).password for s in self.origins):
            raise ValueError("explicit browser origins without paths are required")
        if not 1 <= settings.request_limit_per_minute <= 10000 or not 1024 <= settings.max_body_bytes <= 20000000:
            raise ValueError("invalid request limits")
        if min(settings.max_run_cpu_millis, settings.max_run_ram_mb, settings.max_pending_runs, settings.max_tenant_pending_runs) < 1:
            raise ValueError("run budgets and queue capacity must be positive")
        if settings.deployment_mode == "company":
            if settings.auth_mode != "tokens" or not settings.cookie_secure or any(not s.startswith("https://") for s in self.origins):
                raise ValueError("company deployment requires authentication, secure cookies and HTTPS origins")
            database_password = urlsplit(settings.database_url).password or ""
            if len(settings.neo4j_password) < 24 or len(database_password) < 24 or "change-me" in settings.database_url:
                raise ValueError("company deployment requires database credentials of at least 24 characters")
        if settings.auth_mode == "tokens":
            self.manifest()  # Fail startup rather than run with missing authentication.

    def manifest(self) -> Manifest:
        """File-managed identities merged with database-managed ones (the file wins on a clash)."""
        file = self._file_manifest()
        snap = self.directory.snapshot if self.directory is not None else None
        if snap is None:
            return file
        return Manifest({**snap.tenants, **file.tenants}, {**snap.principals, **file.principals},
                        {**snap.agents, **file.agents}, file.default_agent_tenant,
                        frozenset(snap.revoked_agents - set(file.agents)))

    def _file_manifest(self) -> Manifest:
        path = Path(self.settings.auth_file)
        if self.allow_missing_manifest and not path.exists():
            return Manifest({}, {}, {}, None)
        try:
            if path.stat().st_size > 2_000_000:
                raise ValueError()
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") == 1:
                tenants, principals, agents, fallback = _parse_v1(data)
            elif data.get("version") == 2:
                tenants, principals, agents, fallback = _parse_v2(data)
            else:
                raise ValueError()
            hashes = set()
            for row in principals.values():
                if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", row["id"]) or not re.fullmatch(r"[0-9a-f]{64}", row["token_sha256"]):
                    raise ValueError()
                expires = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
                if expires.tzinfo is None or row["token_sha256"] in hashes:
                    raise ValueError()
                hashes.add(row["token_sha256"])
                row["expiry"] = expires.timestamp()
            return Manifest(tenants, principals, agents, fallback)
        except Exception:
            # Config contents and file system diagnostics may be sensitive.
            raise RuntimeError("authentication configuration unavailable or invalid") from None

    def records(self):
        return self.manifest().principals

    def _current_manifest(self) -> Manifest:
        if self.settings.auth_mode == "lab":
            tenant = self.settings.lab_tenant
            return Manifest({tenant: {"id": tenant, "name": "Local lab", "status": "active"}}, {}, {}, tenant)
        return self.manifest()

    def agent_tenant(self, agent_id: str) -> str | None:
        """Tenant that owns an enrolled agent identity, or None to refuse its telemetry."""
        manifest = self._current_manifest()
        if agent_id in manifest.revoked_agents:
            return None  # A revoked enrollment never falls back to the default tenant.
        tenant = manifest.agents.get(agent_id, manifest.default_agent_tenant)
        if tenant is None or manifest.tenants.get(tenant, {}).get("status") != "active":
            return None
        return tenant

    def tenant_info(self, tenant: str) -> dict | None:
        manifest = self._current_manifest()
        info = manifest.tenants.get(tenant)
        if info is None:
            return None
        agents = sum(1 for value in manifest.agents.values() if value == tenant)
        managed = "database" if self.directory is not None and tenant in self.directory.snapshot.tenants and tenant not in self._file_manifest().tenants else "file"
        return {**info, "registered_agents": agents, "accepts_unregistered_agents": manifest.default_agent_tenant == tenant, "managed_by": managed}

    def manifest_has_platform_admin(self) -> bool:
        return any(row.get("platform_admin") for row in self._file_manifest().principals.values())

    @staticmethod
    def _resolve(manifest: Manifest, principal_id: str, fingerprint: str, tenant: str | None) -> Principal | None:
        """Bind a principal to one active tenant; None when the credential or membership is gone."""
        row = manifest.principals.get(principal_id)
        if not row or row["expiry"] <= time.time() or not hmac.compare_digest(row["token_sha256"], fingerprint):
            return None
        active = {t: r for t, r in row["memberships"].items() if manifest.tenants.get(t, {}).get("status") == "active"}
        platform = bool(row.get("platform_admin"))
        extra = {"platform_admin": platform, "kind": row.get("kind", "token"), "display_name": row.get("display_name", "")}
        listing = tuple((t, manifest.tenants[t]["name"], active[t]) for t in sorted(active))
        if platform and (tenant == "" or (tenant is None and not active)):
            # The platform console has no workspace; tenant-scoped routes refuse it.
            return Principal(principal_id, "viewer", fingerprint, "", listing, **extra)
        if not active:
            return None
        if tenant is None:
            tenant = sorted(active)[0]
        if tenant not in active:
            return None
        return Principal(principal_id, active[tenant], fingerprint, tenant, listing, **extra)

    def token(self, token, tenant: str | None = None):
        if not isinstance(token, str) or not 32 <= len(token) <= 256:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        manifest = self.manifest()
        for principal_id, row in manifest.principals.items():
            # Database accounts sign in with passwords only; their fingerprint is not a token.
            if row.get("kind") != "password" and hmac.compare_digest(row["token_sha256"], digest):
                return self._resolve(manifest, principal_id, digest, tenant)
        return None

    def authenticate(self, request):
        if self.settings.auth_mode == "lab":
            tenant = self.settings.lab_tenant
            return Principal("insecure-lab", "admin", "", tenant, ((tenant, "Local lab", "admin"),))
        requested = request.headers.get("x-tenant")
        if requested is not None and not re.fullmatch(TENANT_PATTERN, requested):
            return None
        authorization = request.headers.get("authorization", "")
        if authorization:
            scheme, _, token = authorization.partition(" ")
            return self.token(token, requested) if scheme.lower() == "bearer" else None
        cookie = request.cookies.get(COOKIE, "")
        if not cookie or len(cookie) > 256:
            return None
        key = hashlib.sha256(cookie.encode()).hexdigest()
        session = self.sessions.get(key)
        if not session:
            return None
        principal, expiry = session
        current = None
        if expiry > time.time():
            current = self._resolve(self.manifest(), principal.id, principal.fingerprint, principal.tenant)
        # A header can never move a cookie session into another tenant.
        if current is None or current.role != principal.role or (requested is not None and requested != principal.tenant):
            self.sessions.pop(key, None)
            return None
        return current

    def login(self, token, tenant: str | None = None):
        principal = self.token(token, tenant)
        if principal is None:
            raise HTTPException(401, "invalid or expired credential")
        return self._open_session(principal)

    async def login_password(self, user_id: str, password: str, tenant: str | None = None):
        if self.directory is None:
            raise HTTPException(401, "invalid username or password")
        fingerprint = await self.directory.verify_login(user_id, password)
        principal = self._resolve(self.manifest(), user_id, fingerprint, tenant) if fingerprint else None
        if principal is None:
            raise HTTPException(401, "invalid username or password")
        return self._open_session(principal)

    def switch_tenant(self, request, tenant: str):
        """Re-authorize a browser session for another membership and rotate its identifier."""
        if not request.cookies.get(COOKIE) or request.headers.get("authorization"):
            raise HTTPException(400, "bearer clients select a tenant with the X-Tenant header")
        current = self.authenticate(request)
        if current is None:
            raise HTTPException(401, "authentication required")
        target = self._resolve(self.manifest(), current.id, current.fingerprint, tenant)
        if target is None:
            raise HTTPException(403, "no active membership in the requested tenant")
        self.logout(request)
        return self._open_session(target)

    def _open_session(self, principal):
        now = time.time()
        self.sessions = {key: value for key, value in self.sessions.items() if value[1] > now}
        if len(self.sessions) >= 1000:
            raise HTTPException(503, "session capacity reached")
        secret = secrets.token_urlsafe(32)
        self.sessions[hashlib.sha256(secret.encode()).hexdigest()] = (principal, now + self.settings.session_seconds)
        return secret, principal

    def logout(self, request):
        cookie = request.cookies.get(COOKIE, "")
        self.sessions.pop(hashlib.sha256(cookie.encode()).hexdigest(), None)

    def require_origin(self, request):
        origin = request.headers.get("origin")
        if origin and origin not in self.origins:
            raise HTTPException(403, "browser origin is not allowed")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.cookies.get(COOKIE) and not request.headers.get("authorization") and origin not in self.origins:
            raise HTTPException(403, "browser mutations require an allowed origin")


class RateLimiter:
    def __init__(self):
        self.windows = OrderedDict()

    def allow(self, key, limit):
        now = time.monotonic()
        bucket = self.windows.setdefault(key, deque())
        self.windows.move_to_end(key)
        while len(self.windows) > 4096:
            self.windows.popitem(last=False)
        while bucket and bucket[0] <= now - 60:
            bucket.popleft()
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        return True


PUBLIC_ROUTES = {
    ("GET", "/api/setup"): "setup.status", ("POST", "/api/setup"): "setup.complete",
    ("POST", "/api/invites/describe"): "invite.describe", ("POST", "/api/invites/accept"): "invite.accept",
    ("POST", "/api/enroll"): "agent.enroll",
}


def access_rule(method, path):
    """Return a fixed audit action and required role; never record query/body data.

    Roles: "public" needs no session; "platform" needs a platform admin; "session"
    needs any signed-in principal; viewer/operator/admin are per-workspace roles.
    """
    if (method, path) in PUBLIC_ROUTES:
        return PUBLIC_ROUTES[(method, path)], "public"
    if path.startswith("/api/platform/") or path == "/api/platform":
        return "platform." + {"GET": "read", "POST": "write", "PUT": "write", "DELETE": "write"}.get(method, "unknown"), "platform"
    if path == "/api/account/password" and method == "POST":
        return "account.password", "session"
    if path.startswith("/api/team") or path.startswith("/api/enrollment"):
        return ("team." if path.startswith("/api/team") else "enrollment.") + ("read" if method == "GET" else "write"), "admin"
    if path == "/api/hosts" and method == "GET":
        return "hosts.read", "viewer"
    if path in {"/api/company/artifacts", "/api/company/runs"}:
        return "company." + ("read" if method == "GET" else "write"), "viewer" if method == "GET" else "operator"
    if re.fullmatch(r"/api/company/runs/[^/]+", path) and method == "GET":
        return "company.evidence.read", "viewer"
    if re.fullmatch(r"/api/hosts/[^/]+/revoke", path) and method == "POST":
        return "hosts.revoke", "admin"
    if method == "GET":
        if path == "/api/admin/audit":
            return "audit.read", "admin"
        if path == "/metrics":
            return "metrics.read", "admin"
        if path == "/api/auth/session":
            return "session.read", "session"
        fixed = {"/api/tenant": "tenant.read", "/api/inventory": "inventory.read",
                 "/api/topology": "topology.read", "/api/measurements": "measurements.read", "/api/paths": "paths.read",
                 "/api/events": "events.read", "/api/emulation/runs": "runs.read", "/api/research/reports": "reports.read",
}
        if path in fixed:
            return fixed[path], "viewer"
        if re.fullmatch(r"/api/(emulation/runs|research/reports)/[^/]+", path):
            return "evidence.read", "viewer"
        if re.fullmatch(r"/api/emulation/runs/[^/]+/sarif", path):
            return "evidence.read", "viewer"
    if method == "PUT" and path.startswith("/api/assets/") and path.endswith("/classification"):
        return "asset.classify", "operator"
    if method == "POST":
        if path == "/api/auth/tenant":
            return "session.switch_tenant", "session"
        if path == "/api/research/insights":
            return "insights.compute", "viewer"
        fixed = {"/api/emulation/plans": "plan.create", "/api/emulation/runs": "run.queue",
                 "/api/research/reports": "report.import"}
        if path in fixed:
            return fixed[path], "operator"
        if re.fullmatch(r"/api/emulation/runs/[^/]+/promote", path):
            return "run.promote", "operator"
    return "route.unknown", "admin"


class BodyLimitMiddleware:
    """Bound body buffering before parsing, including chunked requests."""
    def __init__(self, app, max_bytes):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        small = {"/api/auth/login", "/api/auth/tenant", "/api/setup", "/api/invites/describe", "/api/invites/accept", "/api/enroll"}
        limit = min(self.max_bytes, 16384) if scope["path"] in small else self.max_bytes
        chunks, total = [], 0
        try:
            async with asyncio.timeout(15):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body = message.get("body", b"")
                    total += len(body)
                    if total > limit:
                        return await JSONResponse({"detail": "request body too large"}, 413)(scope, receive, send)
                    chunks.append(body)
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            return await JSONResponse({"detail": "request body timeout"}, 408)(scope, receive, send)
        buffered = b"".join(chunks)
        delivered = False
        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            return await receive()
        await self.app(scope, replay, send)
