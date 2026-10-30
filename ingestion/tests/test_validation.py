import json
import asyncio
from pathlib import Path
import pytest
from twin_ingestion.validation import TelemetryValidator


ROOT = Path(__file__).resolve().parents[2]


def envelope():
    now = "2026-10-25T00:00:00Z"
    return {
        "schema_version": "1.0", "agent_id": "0123456789abcdef", "sequence": 1, "sent_at": now,
        "full_snapshot": True,
        "host": {"id": "0123456789abcdef", "hostname": "lab-linux", "os": "linux", "architecture": "amd64"},
        "components": [], "relationships": [], "gaps": [],
        "metrics": {"collection_ms": 4, "cpu_percent": 0.1, "ram_bytes": 1024, "envelope_bytes": 500, "polling_interval_sec": 30},
    }


def test_valid_envelope():
    validator = TelemetryValidator(str(ROOT / "schema" / "telemetry-v1.schema.json"))
    parsed, _ = validator.validate(json.dumps(envelope()).encode())
    assert parsed.full_snapshot


def test_unknown_field_rejected():
    value = envelope()
    value["secret_dump"] = "should-never-be-accepted"
    validator = TelemetryValidator(str(ROOT / "schema" / "telemetry-v1.schema.json"))
    with pytest.raises(ValueError, match="schema validation"):
        validator.validate(json.dumps(value).encode())


def component(host_id):
    return {"kind": "service", "id": f"service:{host_id}:nginx", "hash": "a" * 64,
            "data": {"name": "nginx"}, "evidence": {
                "source": "lab-fixture", "observed_at": "2026-10-25T00:00:00Z", "confidence": "observed"}}


@pytest.mark.parametrize("mutation", ["component", "removed", "relationship_source", "structural_target", "confirmation"])
def test_agent_cannot_modify_foreign_assets_or_confirm_attacks(mutation):
    value = envelope()
    own = value["agent_id"]
    foreign = "fedcba9876543210"
    relation = {"kind": "OBSERVED_CONNECTION", "source_id": own, "target_id": foreign,
                "evidence": component(own)["evidence"]}
    if mutation == "component":
        value["components"] = [component(foreign)]
    elif mutation == "removed":
        value["removed"] = [f"service:{foreign}:nginx"]
    elif mutation == "relationship_source":
        value["relationships"] = [{**relation, "source_id": foreign}]
    elif mutation == "structural_target":
        value["relationships"] = [{**relation, "kind": "HAS_SERVICE", "target_id": f"service:{foreign}:nginx"}]
    else:
        value["relationships"] = [{**relation, "kind": "CONFIRMED_ATTACK_TRANSITION",
                                    "evidence": {**relation["evidence"], "confidence": "confirmed"}}]
    validator = TelemetryValidator(str(ROOT / "schema" / "telemetry-v1.schema.json"))
    with pytest.raises(ValueError):
        validator.validate(json.dumps(value).encode())


def test_canonical_agent_component_namespace_is_accepted():
    value = envelope()
    own = value["agent_id"]
    value["components"] = [component(own)]
    value["relationships"] = [{"kind": "HAS_SERVICE", "source_id": own,
                               "target_id": f"service:{own}:nginx", "evidence": component(own)["evidence"]}]
    validator = TelemetryValidator(str(ROOT / "schema" / "telemetry-v1.schema.json"))
    parsed, _ = validator.validate(json.dumps(value).encode())
    assert parsed.components[0].id == f"service:{own}:nginx"


def test_invalid_telemetry_secrets_do_not_leak_to_logs_or_ack(caplog):
    from twin_ingestion.service import IngestionService
    value = envelope()
    value["host"]["os"] = "seeded-invalid-field-secret"
    class Context:
        def auth_context(self): return {"x509_common_name": [value["agent_id"].encode()]}
    validator = TelemetryValidator(str(ROOT / "schema" / "telemetry-v1.schema.json"))
    service = IngestionService(validator, None, None, None, lambda agent: "default")
    ack = asyncio.run(service.sync(json.dumps(value).encode(), Context()))
    assert ack["accepted_sequence"] == 0 and ack["error"] == "invalid telemetry"
    assert "seeded-invalid-field-secret" not in caplog.text + json.dumps(ack)


def test_concurrent_reconnects_serialize_graph_apply():
    from twin_ingestion.service import IngestionService
    from twin_ingestion.postgres import Reservation
    class Context:
        def auth_context(self): return {"x509_common_name": [b"0123456789abcdef"]}
    class History:
        last = 0
        async def reserve(self, tenant, value, peer):
            return Reservation(value.sequence <= self.last, False)
        async def applied(self, tenant, value, *args):
            self.last = value.sequence
    class Graph:
        applied = []
        active = 0
        async def apply(self, tenant, value):
            self.active += 1
            assert self.active == 1
            await asyncio.sleep(0.01)
            self.applied.append(value.sequence)
            self.active -= 1
    async def run():
        async def publish(tenant, event): pass
        graph, history = Graph(), History()
        validator = TelemetryValidator(str(ROOT / "schema/telemetry-v1.schema.json"))
        service = IngestionService(validator, history, graph, publish, lambda agent: "default")
        values = [envelope() for _ in range(3)]
        values[1]["sequence"] = 2
        results = await asyncio.gather(*(service.sync(json.dumps(v).encode(), Context()) for v in values))
        assert all(not r["error"] for r in results)
        assert graph.applied == [1, 2] and results[2]["duplicate"]
    asyncio.run(run())

