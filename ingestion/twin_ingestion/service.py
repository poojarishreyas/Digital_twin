import json
import asyncio
import hashlib
import logging
import time
from datetime import datetime, timezone
import grpc
from prometheus_client import Counter, Histogram
from .graph import GraphStore
from .postgres import HistoryStore
from .sanitize import sanitize
from .validation import TelemetryValidator

LOG = logging.getLogger("twin.ingestion")
ENVELOPES = Counter("twin_envelopes_total", "Telemetry envelopes", ["result"])
APPLY_SECONDS = Histogram("twin_graph_apply_seconds", "Graph application latency")


class IngestionService:
    def __init__(self, validator: TelemetryValidator, history: HistoryStore, graph: GraphStore, publish, resolve_tenant):
        self.validator = validator
        # Maps an authenticated certificate identity to its owning tenant, or None.
        self.resolve_tenant = resolve_tenant
        self.history = history
        self.graph = graph
        self.publish = publish
        # Bounded striped locks serialize an agent's reserve/apply/commit in this
        # single-instance deployment, including simultaneous reconnects.
        self._locks = [asyncio.Lock() for _ in range(256)]

    async def sync(self, raw: bytes, context: grpc.aio.ServicerContext) -> dict:
        peer = self._peer_identity(context)
        try:
            envelope, data = self.validator.validate(raw)
            # Defense in depth: validation is followed by a second recursive redaction pass.
            clean_data = sanitize(data)
            envelope = envelope.model_validate(clean_data)
        except Exception as exc:
            ENVELOPES.labels("rejected").inc()
            # Validation exceptions can embed the rejected payload, including
            # secrets in malformed fields. Do not echo them to logs or replies.
            LOG.warning("rejected telemetry from authenticated peer %s: %s", peer, type(exc).__name__)
            return {"accepted_sequence": 0, "duplicate": False, "require_full_snapshot": False, "error": "invalid telemetry"}
        if peer != envelope.agent_id:
            ENVELOPES.labels("rejected").inc()
            LOG.warning("rejected telemetry: certificate identity mismatch")
            return {"accepted_sequence": 0, "duplicate": False, "require_full_snapshot": False,
                    "error": "client certificate identity does not match agent_id"}

        try:
            tenant = self.resolve_tenant(peer)
        except RuntimeError:
            tenant = None
        if tenant is None:
            ENVELOPES.labels("rejected").inc()
            LOG.warning("rejected telemetry: agent identity is not registered to an active tenant")
            return {"accepted_sequence": 0, "duplicate": False, "require_full_snapshot": False,
                    "error": "agent is not enrolled in an active tenant"}

        lock = self._locks[hashlib.sha256(peer.encode()).digest()[0]]
        async with lock:
            return await self._apply(tenant, envelope, peer, len(raw))

    async def _apply(self, tenant, envelope, peer, bytes_received):
        try:
            reservation = await self.history.reserve(tenant, envelope, peer)
            if reservation.duplicate:
                ENVELOPES.labels("duplicate").inc()
                return {"accepted_sequence": envelope.sequence, "duplicate": True,
                        "require_full_snapshot": reservation.require_full, "error": ""}
            started = time.monotonic()
            await self.graph.apply(tenant, envelope)
            APPLY_SECONDS.observe(time.monotonic() - started)
            event_to_graph_ms = max(0, int((datetime.now(timezone.utc) - envelope.sent_at).total_seconds() * 1000))
            await self.history.applied(tenant, envelope, event_to_graph_ms, bytes_received)
            await self.publish(tenant, {"type": "graph_updated", "agent_id": envelope.agent_id,
                                        "sequence": envelope.sequence, "at": datetime.now(timezone.utc).isoformat()})
            ENVELOPES.labels("applied").inc()
            return {"accepted_sequence": envelope.sequence, "duplicate": False,
                    "require_full_snapshot": reservation.require_full, "error": ""}
        except Exception as exc:
            ENVELOPES.labels("failed").inc()
            try:
                await self.history.failed(tenant, envelope, type(exc).__name__)
            except Exception:
                pass
            LOG.error("failed to apply envelope tenant=%s agent=%s sequence=%s category=%s", tenant, envelope.agent_id, envelope.sequence, type(exc).__name__)
            return {"accepted_sequence": 0, "duplicate": False, "require_full_snapshot": True,
                    "error": "ingestion failed; retry is safe"}

    @staticmethod
    def _peer_identity(context) -> str:
        auth = context.auth_context() or {}
        values = auth.get("x509_common_name", [])
        if values:
            return values[0].decode("utf-8", "replace")
        return context.peer()


def add_to_server(server: grpc.aio.Server, service: IngestionService):
    async def handler(raw, context):
        return await service.sync(raw, context)

    method = grpc.unary_unary_rpc_method_handler(
        handler,
        request_deserializer=lambda value: value,
        response_serializer=lambda value: json.dumps(value, separators=(",", ":")).encode(),
    )
    server.add_generic_rpc_handlers((
        grpc.method_handlers_generic_handler("twin.telemetry.v1.TelemetryIngest", {"Sync": method}),
    ))

