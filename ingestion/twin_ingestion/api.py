import asyncio
import json
import logging
from dataclasses import asdict
from uuid import uuid4
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from .graph import GraphStore
from .postgres import HistoryStore
from .settings import Settings
from .phase2.planner import plan as build_plan, services_from_topology
from .phase2.adapters import render
from .phase2.store import RunStore
from .phase3.store import ResearchStore
from .phase3.contracts import Report
from .phase3.metrics import summarize
from .phase3.insights import insights as research_insights
from .path_analysis import analyze_paths
from .sarif import run_detail_to_sarif
from .audit import AuditStore
from .security import AuthManager, BodyLimitMiddleware, COOKIE, RateLimiter, ROLES, access_rule
from .identity import IdentityError, IdentityStore
from .enrollment import CertificateIssuer, EnrollmentError, clean_hostname
from .company.api import register_routes as register_company_routes
from .company.store import CompanyStore


class Classification(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry: bool = False
    critical: bool = False


class EmulationPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_hops: int = Field(default=4, ge=1, le=8)
    cpu_budget_millis: int = Field(default=2000, ge=1)
    ram_budget_mb: int = Field(default=4096, ge=1)


class EmulationRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: str


TENANT_ID = r"^[a-z0-9][a-z0-9-]{0,31}$"


USERNAME = r"^[a-zA-Z0-9_.@-]{3,64}$"
ROLE = r"^(viewer|operator|admin)$"


class LoginRequest(BaseModel):
    """Either an access credential (CLI/legacy) or a username and password."""
    model_config = ConfigDict(extra="forbid")
    token: SecretStr | None = None
    username: str | None = Field(default=None, pattern=USERNAME)
    password: SecretStr | None = None
    tenant: str | None = Field(default=None, pattern=TENANT_ID)


class TenantSwitch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant: str = Field(pattern=r"^$|" + TENANT_ID)  # "" opens the platform console


class SetupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: SecretStr
    username: str = Field(pattern=USERNAME)
    password: SecretStr
    display_name: str = Field(default="", max_length=80)


class InviteToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr


class InviteAccept(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr
    username: str = Field(pattern=USERNAME)
    password: SecretStr
    display_name: str = Field(default="", max_length=80)
    existing: bool = False


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current: SecretStr
    new: SecretStr


class NewCustomer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=TENANT_ID)
    name: str = Field(min_length=1, max_length=80)
    admin_label: str = Field(default="", max_length=80)


class StatusChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str = Field(pattern=r"^(active|suspended)$")


class NewInvite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str = Field(default="viewer", pattern=ROLE)
    label: str = Field(default="", max_length=80)
    hours: int = Field(default=72, ge=1, le=336)


class RoleChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str = Field(pattern=ROLE)


class NewEnrollmentToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(default="", max_length=80)
    minutes: int = Field(default=60, ge=5, le=10080)
    max_uses: int = Field(default=1, ge=1, le=1000)


class EnrollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: SecretStr
    csr: str = Field(max_length=8192)
    hostname: str = Field(default="", max_length=253)
    os: str = Field(default="", max_length=32)


class EventHub:
    """Server-sent events partitioned by tenant: a listener only receives its own tenant's events."""

    def __init__(self, max_listeners: int = 200, max_per_tenant: int = 50):
        self.listeners: dict[asyncio.Queue, str] = {}
        self.max_listeners, self.max_per_tenant = max_listeners, max_per_tenant

    async def publish(self, tenant: str, event: dict):
        for queue, owner in tuple(self.listeners.items()):
            if owner != tenant:
                continue
            if queue.full():
                _ = queue.get_nowait()
            queue.put_nowait(event)

    async def stream(self, request: Request, tenant: str, authorized):
        queue: asyncio.Queue = asyncio.Queue(maxsize=50)
        if len(self.listeners) >= self.max_listeners or sum(1 for t in self.listeners.values() if t == tenant) >= self.max_per_tenant:
            return
        self.listeners[queue] = tenant
        try:
            yield "event: ready\ndata: {}\n\n"
            while not await request.is_disconnected():
                try:
                    if not authorized():
                        return
                except RuntimeError:
                    return
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15)
                    if not authorized():
                        return
                    yield f"event: graph_updated\ndata: {json.dumps(item)}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
                except RuntimeError:
                    return
        finally:
            self.listeners.pop(queue, None)


def create_app(settings: Settings, history: HistoryStore, graph: GraphStore, events: EventHub,
               runs: RunStore | None = None, research: ResearchStore | None = None,
               audit: AuditStore | None = None, identity: IdentityStore | None = None,
               issuer: CertificateIssuer | None = None, setup_code: str | None = None,
               auth: AuthManager | None = None, company: CompanyStore | None = None) -> FastAPI:
    auth = auth or AuthManager(settings, allow_missing_manifest=identity is not None)
    if identity is not None:
        auth.directory = identity
    if settings.auth_mode != "lab" and audit is None:
        raise ValueError("authenticated deployment requires persistent audit storage")
    app = FastAPI(title="Digital Twin API", version="4.0.0", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.auth = auth
    app.add_middleware(CORSMiddleware, allow_origins=list(auth.origins), allow_credentials=True,
                       allow_methods=["GET", "PUT", "POST", "DELETE"], allow_headers=["content-type", "authorization", "x-emulation-token", "x-tenant"])
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_body_bytes)
    limiter = RateLimiter()

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        return JSONResponse({"detail": "invalid request"}, status_code=422)

    @app.middleware("http")
    async def control_access(request: Request, call_next):
        request_id = uuid4()
        path = request.url.path
        public = path in {"/healthz", "/readyz"} and request.method == "GET"
        if public or request.method == "OPTIONS":
            return await call_next(request)
        action, required = access_rule(request.method, path)
        is_login = path == "/api/auth/login" and request.method == "POST"
        is_logout = path == "/api/auth/logout" and request.method == "POST"
        action = "session.login" if is_login else "session.logout" if is_logout else action
        request.state.principal = None

        async def record(stage, status=None):
            if audit:
                principal = request.state.principal
                await asyncio.wait_for(audit.record(request_id, principal.id if principal else "anonymous",
                    principal.role if principal else "none", action, stage, status,
                    tenant=principal.tenant if principal else ""), timeout=3)

        def finish(response):
            response.headers["X-Request-ID"] = str(request_id)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "no-referrer"
            return response

        async def denied(status, detail):
            try:
                await record("denied", status)
            except Exception:
                return finish(JSONResponse({"detail": "audit storage unavailable"}, 503))
            response = JSONResponse({"detail": detail}, status)
            if status == 401:
                response.headers["WWW-Authenticate"] = "Bearer"
            if status == 429:
                response.headers["Retry-After"] = "60"
            return finish(response)

        try:
            auth.require_origin(request)
            principal = auth.authenticate(request)
            request.state.principal = principal
            client = request.client.host if request.client else "unknown"
            # Sign-in, setup and invite routes are brute-force targets; enrollment is
            # bounded per address but allows a fleet rollout behind one NAT.
            sensitive = is_login or action in {"setup.complete", "invite.describe", "invite.accept"}
            if sensitive:
                key, limit = "login:" + client, 10
            elif required == "public":
                key, limit = "public:" + client, settings.request_limit_per_minute
            else:
                key, limit = "user:" + (principal.id if principal else client), settings.request_limit_per_minute
            if not limiter.allow(key, limit):
                return await denied(429, "request limit exceeded")
            if not is_login and not is_logout and required != "public":
                if principal is None:
                    return await denied(401, "authentication required")
                if required == "platform" and not principal.platform_admin:
                    return await denied(403, "platform administrators only")
                if required in ROLES:
                    if not principal.tenant:
                        return await denied(403, "select a customer workspace first")
                    if ROLES[principal.role] < ROLES[required]:
                        return await denied(403, "role does not permit this action")
            length = request.headers.get("content-length")
            if length and (not length.isdigit() or int(length) > settings.max_body_bytes):
                return await denied(413, "request body too large")
        except HTTPException as exc:
            return await denied(exc.status_code, exc.detail)
        except RuntimeError:
            return await denied(503, "authentication service unavailable")
        try:
            await record("intent")
        except Exception:
            return finish(JSONResponse({"detail": "audit storage unavailable; request not executed"}, 503))
        try:
            response = await call_next(request)
        except Exception as exc:
            logging.getLogger("twin.api").error("request failed id=%s category=%s", request_id, type(exc).__name__)
            response = JSONResponse({"detail": "request failed"}, 500)
        try:
            await record("outcome", response.status_code)
        except Exception:
            return finish(JSONResponse({"detail": "request outcome could not be recorded; reconcile using request ID before retrying"}, 503))
        return finish(response)

    def require_emulation_token(value: str | None):
        if settings.auth_mode != "lab":
            return  # Individual operator/admin authorization is enforced above.
        import hmac
        if not settings.emulation_api_token or not value or not hmac.compare_digest(value, settings.emulation_api_token):
            raise HTTPException(403, "emulation API is disabled or token invalid")

    register_company_routes(app, settings, company, graph, events, lambda request: tenant_of(request))

    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @app.get("/readyz")
    async def ready():
        try:
            if settings.auth_mode != "lab":
                auth.records()
            checks = [history.pool.fetchval("SELECT 1"), graph.driver.verify_connectivity()]
            if audit:
                checks.append(audit.ready())
            await asyncio.wait_for(asyncio.gather(*checks), timeout=3)
        except Exception:
            return JSONResponse({"status": "unavailable"}, 503)
        return {"status": "ready"}

    def tenant_of(request: Request) -> str:
        return request.state.principal.tenant

    def describe(principal):
        return {"id": principal.id, "role": principal.role, "tenant": principal.tenant, "auth_mode": settings.auth_mode,
                "platform_admin": principal.platform_admin, "kind": principal.kind, "display_name": principal.display_name,
                "tenants": [{"id": t, "name": name, "role": role} for t, name, role in principal.tenants]}

    def need_identity():
        if identity is None:
            raise HTTPException(503, "customer management requires the identity database")
        return identity

    def actor(request):
        return request.state.principal.id

    def session_response(secret, principal):
        response = JSONResponse(describe(principal))
        response.set_cookie(COOKIE, secret, max_age=settings.session_seconds, httponly=True,
                            secure=settings.cookie_secure, samesite="strict", path="/")
        return response

    @app.post("/api/auth/login")
    async def login(body: LoginRequest, request: Request):
        if settings.auth_mode == "lab":
            raise HTTPException(409, "lab mode has no credential login")
        try:
            if body.username and body.password:
                secret, principal = await auth.login_password(body.username, body.password.get_secret_value(), body.tenant)
            elif body.token:
                secret, principal = auth.login(body.token.get_secret_value(), body.tenant)
            else:
                raise HTTPException(422, "provide a username and password")
        except RuntimeError:
            raise HTTPException(503, "authentication service unavailable") from None
        auth.logout(request)  # Rotate any previous session instead of fixing its identifier.
        request.state.principal = principal
        return session_response(secret, principal)

    @app.post("/api/auth/tenant")
    async def switch_tenant(body: TenantSwitch, request: Request):
        if settings.auth_mode == "lab":
            raise HTTPException(409, "lab mode has a single tenant")
        try:
            secret, principal = auth.switch_tenant(request, body.tenant)
        except RuntimeError:
            raise HTTPException(503, "authentication service unavailable") from None
        request.state.principal = principal
        return session_response(secret, principal)

    @app.get("/api/auth/session")
    async def session(request: Request):
        return describe(request.state.principal)

    # ---------------------------------------------------------------- first-run setup
    @app.get("/api/setup")
    async def setup_status():
        if identity is None or settings.auth_mode == "lab":
            return {"needed": False}
        return {"needed": await identity.needs_setup(auth.manifest_has_platform_admin())}

    @app.post("/api/setup")
    async def complete_setup(body: SetupRequest):
        store = need_identity()
        import hmac
        if not setup_code or not await store.needs_setup(auth.manifest_has_platform_admin()):
            raise HTTPException(409, "setup is not available")
        if not hmac.compare_digest(body.code.get_secret_value().strip(), setup_code):
            raise HTTPException(403, "setup code is incorrect")
        try:
            await store.create_platform_admin(body.username, body.password.get_secret_value(), body.display_name)
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"ok": True}

    # ---------------------------------------------------------------- invites (public)
    @app.post("/api/invites/describe")
    async def describe_invite(body: InviteToken):
        info = await need_identity().describe_invite(body.token.get_secret_value())
        if info is None:
            raise HTTPException(404, "this invite is invalid, expired or already used")
        return {"tenant_id": info["tenant_id"], "tenant_name": info["tenant_name"], "role": info["role"],
                "platform_admin": info["platform_admin"], "expires_at": info["expires_at"].isoformat()}

    @app.post("/api/invites/accept")
    async def accept_invite(body: InviteAccept):
        try:
            result = await need_identity().accept_invite(body.token.get_secret_value(), body.username,
                                                          body.password.get_secret_value(), body.display_name, body.existing)
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"ok": True, **result}

    @app.post("/api/account/password")
    async def change_password(body: PasswordChange, request: Request):
        if request.state.principal.kind != "password":
            raise HTTPException(409, "this sign-in uses an issued credential; ask an administrator to rotate it")
        try:
            await need_identity().change_password(actor(request), body.current.get_secret_value(), body.new.get_secret_value())
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"ok": True}

    # ---------------------------------------------------------------- platform console
    @app.get("/api/platform/tenants")
    async def platform_tenants():
        store = need_identity()
        manifest = auth.manifest()
        stats = await store.tenant_overview(sorted(manifest.tenants))
        file_tenants = auth._file_manifest().tenants
        members = {t: 0 for t in manifest.tenants}
        for row in manifest.principals.values():
            for t in row["memberships"]:
                if t in members:
                    members[t] += 1
        result = []
        for tenant_id, info in sorted(manifest.tenants.items()):
            row = stats.get(tenant_id, {})
            result.append({**info, "managed_by": "file" if tenant_id in file_tenants else "database",
                           "members": members[tenant_id], "enrolled_agents": row.get("enrolled_agents", 0),
                           "known_agents": row.get("known_agents", 0), "reporting_agents": row.get("reporting_agents", 0),
                           "last_report": row.get("last_report"), "runs": row.get("runs", 0), "active_runs": row.get("active_runs", 0),
                           "pending_invites": row.get("pending_invites", 0), "created_at": row.get("created_at")})
        return result

    @app.post("/api/platform/tenants", status_code=201)
    async def create_customer(body: NewCustomer, request: Request):
        store = need_identity()
        try:
            await store.create_tenant(body.id, body.name, actor(request))
            token, invite = await store.create_invite(actor(request), body.id, "admin", label=body.admin_label or "First administrator")
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"tenant": {"id": body.id, "name": body.name.strip(), "status": "active"}, "invite_token": token, "invite": invite}

    @app.post("/api/platform/tenants/{tenant_id}/status")
    async def customer_status(tenant_id: str, body: StatusChange):
        if tenant_id in auth._file_manifest().tenants:
            raise HTTPException(409, "this customer is managed by the manifest file")
        try:
            await need_identity().set_tenant_status(tenant_id, body.status)
        except KeyError:
            raise HTTPException(404, "customer not found") from None
        return {"ok": True}

    @app.post("/api/platform/tenants/{tenant_id}/invites", status_code=201)
    async def customer_invite(tenant_id: str, body: NewInvite, request: Request):
        try:
            token, invite = await need_identity().create_invite(actor(request), tenant_id, body.role, label=body.label, hours=body.hours)
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"invite_token": token, "invite": invite}

    @app.post("/api/platform/admins/invites", status_code=201)
    async def platform_admin_invite(body: NewInvite, request: Request):
        token, invite = await need_identity().create_invite(actor(request), None, None, platform_admin=True,
                                                             label=body.label, hours=body.hours)
        return {"invite_token": token, "invite": invite}

    # ---------------------------------------------------------------- customer team
    @app.get("/api/team")
    async def team(request: Request):
        data = await need_identity().team(tenant_of(request))
        manifest = auth._file_manifest()
        managed = [{"id": pid, "display_name": "", "role": row["memberships"][tenant_of(request)], "managed_by": "file"}
                   for pid, row in manifest.principals.items() if tenant_of(request) in row["memberships"]]
        return {"members": [{**m, "managed_by": "database"} for m in data["members"]] + managed, "invites": data["invites"]}

    @app.post("/api/team/invites", status_code=201)
    async def team_invite(body: NewInvite, request: Request):
        try:
            token, invite = await need_identity().create_invite(actor(request), tenant_of(request), body.role, label=body.label, hours=body.hours)
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"invite_token": token, "invite": invite}

    @app.delete("/api/team/invites/{invite_id}")
    async def team_revoke_invite(invite_id: str, request: Request):
        try:
            await need_identity().revoke_invite(tenant_of(request), invite_id)
        except (KeyError, ValueError):
            raise HTTPException(404, "invite not found") from None
        return {"ok": True}

    @app.put("/api/team/members/{user_id}")
    async def team_role(user_id: str, body: RoleChange, request: Request):
        try:
            await need_identity().set_member_role(tenant_of(request), user_id, body.role)
        except KeyError:
            raise HTTPException(404, "member not found") from None
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"ok": True}

    @app.delete("/api/team/members/{user_id}")
    async def team_remove(user_id: str, request: Request):
        try:
            await need_identity().remove_member(tenant_of(request), user_id)
        except KeyError:
            raise HTTPException(404, "member not found") from None
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"ok": True}

    # ---------------------------------------------------------------- hosts and enrollment
    @app.post("/api/enrollment/tokens", status_code=201)
    async def new_enrollment_token(body: NewEnrollmentToken, request: Request):
        if issuer is None:
            raise HTTPException(503, "agent enrollment is not configured on this server")
        try:
            token, info = await need_identity().create_enrollment_token(tenant_of(request), actor(request), body.label, body.minutes, body.max_uses)
        except IdentityError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"token": token, **info, "server_address": settings.public_grpc_address}

    @app.get("/api/enrollment/tokens")
    async def list_enrollment_tokens(request: Request):
        return {"enabled": issuer is not None, "tokens": await need_identity().enrollment_tokens(tenant_of(request))}

    @app.post("/api/enrollment/tokens/{token_id}/revoke")
    async def revoke_enrollment_token(token_id: str, request: Request):
        try:
            await need_identity().revoke_enrollment_token(tenant_of(request), token_id)
        except (KeyError, ValueError):
            raise HTTPException(404, "token not found") from None
        return {"ok": True}

    @app.get("/api/hosts")
    async def hosts(request: Request):
        return await need_identity().hosts(tenant_of(request)) if identity is not None else []

    @app.post("/api/hosts/{agent_id}/revoke")
    async def revoke_host(agent_id: str, request: Request):
        try:
            await need_identity().revoke_agent(tenant_of(request), agent_id, actor(request))
        except KeyError:
            raise HTTPException(404, "host not found") from None
        await events.publish(tenant_of(request), {"type": "host_revoked", "agent_id": agent_id})
        return {"ok": True}

    @app.post("/api/enroll")
    async def enroll(body: EnrollRequest):
        """Called by the agent installer. The token is the only credential; it is single-tenant and short-lived."""
        if issuer is None:
            raise HTTPException(503, "agent enrollment is not configured on this server")
        try:
            csr = issuer.check_csr(body.csr)
            result = await need_identity().enroll(
                body.token.get_secret_value(), lambda agent_id: issuer.issue(csr, agent_id),
                clean_hostname(body.hostname), body.os.lower()[:32],
                lambda tenant: auth.tenant_info(tenant) is not None and auth.tenant_info(tenant)["status"] == "active")
        except (EnrollmentError, IdentityError) as exc:
            raise HTTPException(400, str(exc)) from None
        if audit is not None:
            await audit.record(uuid4(), "enrollment:" + result["token_id"], "agent", "agent.enrolled", "outcome", 201, tenant=result["tenant_id"])
        await events.publish(result["tenant_id"], {"type": "host_enrolled", "agent_id": result["agent_id"]})
        return {"agent_id": result["agent_id"], "certificate": result["certificate"], "issuer_certificate": issuer.issuer_pem,
                "ca_certificate": issuer.server_ca_pem, "server_address": settings.public_grpc_address,
                "server_name": settings.grpc_server_name}

    @app.get("/api/tenant")
    async def tenant_detail(request: Request):
        tenant = tenant_of(request)
        try:
            info = auth.tenant_info(tenant)
        except RuntimeError:
            raise HTTPException(503, "authentication service unavailable") from None
        if info is None:
            raise HTTPException(404, "tenant not found")
        return {**info, "quotas": {"max_pending_runs": settings.max_tenant_pending_runs,
                                   "max_run_cpu_millis": settings.max_run_cpu_millis,
                                   "max_run_ram_mb": settings.max_run_ram_mb,
                                   "max_path_depth": settings.max_path_depth},
                "isolation": {"graph": "tenant-scoped node keys", "history": "tenant-keyed rows",
                              "events": "tenant-partitioned stream", "sandbox": "per-run internal networks labeled by tenant"}}

    @app.post("/api/auth/logout")
    async def logout(request: Request):
        auth.logout(request)
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE, path="/", httponly=True, secure=settings.cookie_secure, samesite="strict")
        return response

    @app.get("/api/admin/audit")
    async def audit_records(request: Request, limit: int = Query(100, ge=1, le=1000)):
        if audit is None:
            raise HTTPException(503, "audit storage unavailable")
        return await audit.recent(tenant_of(request), limit)

    @app.get("/metrics")
    async def prometheus_metrics(request: Request):
        # Process counters aggregate every tenant, so only platform operators read them.
        principal = request.state.principal
        if settings.auth_mode != "lab" and not principal.platform_admin and tenant_of(request) != settings.operator_tenant:
            raise HTTPException(403, "platform metrics are restricted to the operator tenant")
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/api/inventory")
    async def inventory(request: Request):
        return await history.inventory(tenant_of(request), settings.stale_after_seconds)

    @app.get("/api/topology")
    async def topology(request: Request):
        return await graph.topology(tenant_of(request))

    @app.get("/api/measurements")
    async def measurements(request: Request, limit: int = Query(200, ge=1, le=1000)):
        return await history.metrics(tenant_of(request), limit)

    @app.put("/api/assets/{asset_id:path}/classification")
    async def classify(asset_id: str, body: Classification, request: Request):
        tenant = tenant_of(request)
        if not await graph.classify(tenant, asset_id, body.entry, body.critical):
            raise HTTPException(404, "asset not found")
        await events.publish(tenant, {"type": "classification_updated", "asset_id": asset_id})
        return {"ok": True}

    @app.get("/api/paths")
    async def paths(request: Request, max_depth: int = Query(4, ge=1), isolated_asset: str | None = Query(None, max_length=1024)):
        if max_depth > settings.max_path_depth:
            raise HTTPException(400, f"max_depth must be <= {settings.max_path_depth}")
        tenant = tenant_of(request)
        snapshot, agents = await asyncio.gather(graph.topology(tenant), history.inventory(tenant, settings.stale_after_seconds))
        try:
            return analyze_paths(snapshot, agents, max_depth, settings.stale_after_seconds, isolated_asset)
        except KeyError as exc:
            raise HTTPException(404, "isolated asset is not in the current topology") from exc

    @app.get("/api/events")
    async def event_stream(request: Request):
        tenant = tenant_of(request)

        def authorized():
            # Re-checked per event: revocation or a tenant switch ends the stream.
            principal = auth.authenticate(request)
            return principal is not None and principal.tenant == tenant
        return StreamingResponse(events.stream(request, tenant, authorized), media_type="text/event-stream")

    @app.post("/api/emulation/plans")
    async def create_plan(body: EmulationPlanRequest, request: Request, x_emulation_token: str | None = Header(None)):
        require_emulation_token(x_emulation_token)
        if body.cpu_budget_millis > settings.max_run_cpu_millis or body.ram_budget_mb > settings.max_run_ram_mb:
            raise HTTPException(400, "requested resources exceed the server budget")
        if runs is None:
            raise HTTPException(503, "emulation store unavailable")
        tenant = tenant_of(request)
        snapshot = await graph.topology(tenant)
        entries = [n["id"] for n in snapshot["nodes"] if n["properties"].get("entry")]
        critical = [n["id"] for n in snapshot["nodes"] if n["properties"].get("critical")]
        services = services_from_topology(snapshot)
        eligible = []
        excluded = []
        for service in services:
            rendered = render(service.kind, service.version, list(service.directives),
                              list(service.hba_rules), list(service.unsupported), "twin-upstream:8080")
            if rendered.supported:
                eligible.append(service)
            else:
                excluded.append({"id": service.id, "reason": ";".join(rendered.fidelity_gaps)})
        try:
            proposal = build_plan(entries, critical, snapshot["edges"], eligible,
                                  body.max_hops, body.cpu_budget_millis, body.ram_budget_mb)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        proposal.excluded.extend(excluded)
        if snapshot["truncated_nodes"] or snapshot["truncated_edges"]:
            proposal.excluded.append({"id": "graph_snapshot", "reason": "topology_query_truncated_at_10000_nodes_or_30000_edges"})
        payload = proposal.as_dict()
        payload["budget"] = {"cpu_millis": body.cpu_budget_millis, "ram_mb": body.ram_budget_mb}
        plan_id = await runs.create_plan(tenant, payload, [asdict(service) for service in eligible], snapshot)
        return {"plan_id": plan_id, "plan": payload}

    @app.post("/api/emulation/runs", status_code=202)
    async def queue_run(body: EmulationRunRequest, request: Request, x_emulation_token: str | None = Header(None)):
        require_emulation_token(x_emulation_token)
        if runs is None:
            raise HTTPException(503, "emulation store unavailable")
        tenant = tenant_of(request)
        try:
            run_id = await runs.queue(tenant, body.plan_id, settings.max_pending_runs,
                                      settings.max_run_cpu_millis, settings.max_run_ram_mb,
                                      settings.max_tenant_pending_runs)
        except KeyError:
            raise HTTPException(404, "plan not found")
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        await events.publish(tenant, {"type": "emulation_queued", "run_id": run_id})
        return {"run_id": run_id, "status": "queued"}

    @app.get("/api/emulation/runs")
    async def recent_runs(request: Request, limit: int = Query(50, ge=1, le=100)):
        return await runs.recent(tenant_of(request), limit) if runs else []

    @app.get("/api/emulation/runs/{run_id}")
    async def run_detail(run_id: str, request: Request):
        if runs is None:
            raise HTTPException(503, "emulation store unavailable")
        try:
            detail = await runs.detail(tenant_of(request), run_id)
        except ValueError:
            detail = None
        if detail is None:
            raise HTTPException(404, "run not found")
        return detail

    @app.get("/api/emulation/runs/{run_id}/sarif")
    async def run_sarif(run_id: str, request: Request, include_not_reproduced: bool = Query(False)):
        if runs is None:
            raise HTTPException(503, "emulation store unavailable")
        tenant = tenant_of(request)
        try:
            detail = await runs.detail(tenant, run_id)
        except ValueError:
            detail = None
        if detail is None:
            raise HTTPException(404, "run not found")
        return run_detail_to_sarif(detail, tenant=tenant, include_not_reproduced=include_not_reproduced)

    @app.post("/api/research/reports", status_code=201)
    async def import_report(body: Report, request: Request, x_emulation_token: str | None = Header(None)):
        require_emulation_token(x_emulation_token)
        if research is None:
            raise HTTPException(503, "research store unavailable")
        try:
            await research.put(tenant_of(request), body)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"run_id": body.run_id}

    @app.get("/api/research/reports")
    async def research_reports(request: Request):
        return await research.recent(tenant_of(request)) if research else []

    @app.get("/api/research/reports/{run_id}")
    async def research_report(run_id: str, request: Request):
        try:
            value = await research.get(tenant_of(request), run_id) if research else None
        except ValueError:
            value = None
        if value is None:
            raise HTTPException(404, "research report not found")
        return {"report": value, "summary": summarize(value), "insights": research_insights(value)}

    @app.post("/api/research/insights")
    async def analyze_report(body: Report):
        # Read-only analysis of a report opened locally; nothing is stored.
        value = body.model_dump()
        return {"summary": summarize(value), "insights": research_insights(value)}

    return app

