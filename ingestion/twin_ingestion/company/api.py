from fastapi import HTTPException, Request
from .contracts import Artifact, QueueRequest, discover
from .runtime import JOB_CPU_MILLIS, JOB_RAM_MB


def register_routes(app, settings, store, graph, events, tenant_of):
    def available():
        if store is None:
            raise HTTPException(503, "company scenario store unavailable")
        return store

    @app.post("/api/company/artifacts", status_code=201)
    async def register_artifact(body: Artifact, request: Request):
        identifier = await available().put_artifact(tenant_of(request), body)
        return {"artifact_id": identifier, "status": "registered",
                "execution": "requires native discovery, approved worker images and a queued job"}

    @app.get("/api/company/artifacts")
    async def artifacts(request: Request):
        return await available().artifacts(tenant_of(request))

    @app.post("/api/company/runs", status_code=202)
    async def queue(body: QueueRequest, request: Request):
        current = available()
        tenant = tenant_of(request)
        artifact = await current.artifact(tenant, body.artifact_id)
        if artifact is None:
            raise HTTPException(404, "deployment artifact not found")
        if settings.max_run_cpu_millis < JOB_CPU_MILLIS or settings.max_run_ram_mb < JOB_RAM_MB:
            raise HTTPException(409, "company original and candidate exceed the configured job resource budget")
        try:
            discovery = discover(artifact, await graph.topology(tenant))
            identifier = await current.queue(tenant, body.artifact_id, discovery,
                settings.max_pending_runs, settings.max_tenant_pending_runs)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        await events.publish(tenant, {"type": "company_run_queued", "run_id": identifier})
        return {"run_id": identifier, "status": "queued"}

    @app.get("/api/company/runs")
    async def recent(request: Request):
        return await available().recent(tenant_of(request))

    @app.get("/api/company/runs/{run_id}")
    async def detail(run_id: str, request: Request):
        try:
            value = await available().get(tenant_of(request), run_id)
        except ValueError:
            value = None
        if value is None:
            raise HTTPException(404, "company run not found")
        return value
