import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from twin_ingestion.phase2.store import RunStore


class Connection:
    def __init__(self, plan, pending=0):
        self.plan, self.pending, self.inserts = plan, pending, 0
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    def transaction(self): return self
    async def execute(self, sql, *args):
        if sql.startswith("INSERT"): self.inserts += 1
    async def fetchval(self, sql, *args): return self.pending
    async def fetchrow(self, sql, *args): return {"plan": self.plan}


@pytest.mark.parametrize("budget", [{}, {"cpu_millis": 3000, "ram_mb": 1024}, {"cpu_millis": 1000, "ram_mb": -1}])
def test_stale_or_excessive_plan_cannot_bypass_current_budget(budget):
    conn = Connection({"waves": [{}], "budget": budget})
    store = RunStore(SimpleNamespace(acquire=lambda: conn))
    with pytest.raises(ValueError, match="current server budget"):
        asyncio.run(store.queue("acme", str(uuid4())))
    assert conn.inserts == 0


def test_queue_full_refuses_admission():
    conn = Connection({}, pending=10)
    store = RunStore(SimpleNamespace(acquire=lambda: conn))
    with pytest.raises(ValueError, match="queue capacity"):
        asyncio.run(store.queue("acme", str(uuid4())))
    assert conn.inserts == 0


class TenantConnection(Connection):
    """Global queue has room; this tenant already holds its fair share."""
    async def fetchval(self, sql, *args):
        return 3 if "tenant_id" in sql else 0


def test_tenant_fair_share_refuses_admission():
    conn = TenantConnection({"waves": [{}], "budget": {"cpu_millis": 100, "ram_mb": 100}})
    store = RunStore(SimpleNamespace(acquire=lambda: conn))
    with pytest.raises(ValueError, match="tenant run queue capacity"):
        asyncio.run(store.queue("acme", str(uuid4()), max_tenant_pending=3))
    assert conn.inserts == 0
