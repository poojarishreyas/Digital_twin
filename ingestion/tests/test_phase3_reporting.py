from types import SimpleNamespace
from fastapi.testclient import TestClient
from twin_ingestion.api import create_app, EventHub
from twin_ingestion.settings import Settings
from twin_ingestion.phase3.contracts import Report
from twin_ingestion.phase3.metrics import summarize
from twin_ingestion.phase3.runtime import ResourceSampler


def test_missing_runs_are_not_successful_negatives():
    report = {"rows": [dict(baseline="ai", repetition=1, status="unavailable", truth=True, truth_verified=True,
                            prediction=None, elapsed_seconds=0)], "patches": []}
    m = summarize(report)["baselines"]["ai"]
    assert m["f1"] is None and m["tn"] == 0 and m["coverage"] == 0 and m["unavailable_rate"] == 1


def test_resource_counter_includes_first_observation_and_no_double_count():
    container = SimpleNamespace(id="one", stats=lambda **kw: {"memory_stats": {"usage": 1048576},
        "cpu_stats": {"cpu_usage": {"total_usage": 500000000}}})
    sampler = ResourceSampler(SimpleNamespace(containers=[container]))
    sampler._collect()
    sampler._collect()
    assert sampler.metrics["cpu_seconds"] == .5
    assert sampler.metrics["peak_ram_mb"] == 1


def test_report_mutation_requires_token_and_preserves_unavailable_rows():
    class Store:
        value = None
        async def put(self, tenant, report): self.value = report.model_dump()
        async def get(self, tenant, run_id): return self.value
        async def recent(self, tenant): return []
    store = Store()
    app = create_app(Settings(auth_mode="lab", emulation_api_token="test-only"), None, None, EventHub(), research=store)
    client = TestClient(app)
    report = Report(run_id="12345678-1234-1234-1234-123456789012", created_at="2026-10-25T00:00:00Z",
        mode="desktop_smoke", manifest_hash="a"*64, model_lock={}, budgets={}, environment={}, rows=[], limitations=[])
    assert client.post("/api/research/reports", json=report.model_dump()).status_code == 403
    assert client.post("/api/research/reports", json=report.model_dump(), headers={"X-Emulation-Token": "test-only"}).status_code == 201
    assert client.get("/api/research/reports/"+report.run_id).json()["report"]["mode"] == "desktop_smoke"
