"""Model calls happen in the control plane; workload networks stay isolated."""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

MODELS = Path(__file__).resolve().parents[3] / "deploy" / "models"
# Gemini 3.8 Flash through the OmniRoute gateway is the primary TwinHunter model.
# The pinned local Qwen profile remains available with TWIN_MODEL_BACKEND=local.
DEFAULT_BACKEND = "omniroute"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("model endpoint redirects are disabled")


class CompatibleModel:
    def __init__(self, lock: dict, endpoint: str = "http://127.0.0.1:8000/v1", seed: int = 0):
        url = urlsplit(endpoint)
        if url.username or url.password or url.query or url.fragment:
            raise ValueError("invalid model endpoint")
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise ValueError("remote control-plane model endpoints require HTTPS")
        self.endpoint, self.lock, self.seed = endpoint.rstrip("/"), lock, seed
        self.identity = {**lock, "seed": seed, "temperature": 0, "endpoint_kind": "local" if url.hostname in {"localhost", "127.0.0.1", "::1"} else "remote_control_plane"}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def decide(self, messages, schema, max_tokens, timeout):
        if len(json.dumps(messages).encode()) + len(json.dumps(schema).encode()) + max_tokens + 512 > self.lock["context_length"]:
            raise ValueError("conservative context budget exceeded")
        payload = {"model": self.lock["served_name"], "messages": messages, "temperature": 0,
                   "seed": self.seed, "max_tokens": max_tokens,
                   "chat_template_kwargs": {"enable_thinking": False},
                   "response_format": {"type": "json_schema", "json_schema": {
                       "name": "hunter_decision", "strict": True, "schema": schema}}}
        headers = {"Content-Type": "application/json"}
        if key := os.environ.get("TWIN_MODEL_API_KEY"):
            headers["Authorization"] = "Bearer " + key
        request = urllib.request.Request(self.endpoint + "/chat/completions", data=json.dumps(payload).encode(), headers=headers)
        with self.opener.open(request, timeout=timeout) as response:
            data = response.read(131073)
        if len(data) > 131072:
            raise ValueError("oversized model response")
        result = json.loads(data)
        return json.loads(result["choices"][0]["message"]["content"]), result.get("usage", {})


class OmniRouteModel(CompatibleModel):
    """Use a named OmniRoute combo; keep routing provenance with each decision."""

    def __init__(self, model_id: str, endpoint: str = "http://127.0.0.1:20128/v1", seed: int = 0,
                 context_length: int = 16384, expected_upstream: str = ""):
        if not model_id or any(c.isspace() for c in model_id):
            raise ValueError("set the exact OmniRoute combo ID from GET /v1/models")
        if not os.environ.get("TWIN_MODEL_API_KEY"):
            raise ValueError("TWIN_MODEL_API_KEY is required for OmniRoute")
        super().__init__({"served_name": model_id, "context_length": context_length}, endpoint, seed)
        self.expected_upstream = expected_upstream.strip().lower()
        self.identity = {"backend": "omniroute", "requested_model": model_id,
                         "expected_upstream": self.expected_upstream or None,
                         "endpoint_kind": self.identity["endpoint_kind"],
                         "routing": "combo; upstream may vary", "seed": seed}

    def decide(self, messages, schema, max_tokens, timeout):
        if len(json.dumps(messages).encode()) + len(json.dumps(schema).encode()) + max_tokens + 512 > self.lock["context_length"]:
            raise ValueError("conservative context budget exceeded")
        payload = {"model": self.lock["served_name"], "messages": messages, "max_tokens": max_tokens,
                   "response_format": {"type": "json_schema", "json_schema": {
                       "name": "hunter_decision", "strict": False, "schema": omniroute_decision_schema()}}}
        request = urllib.request.Request(self.endpoint + "/chat/completions",
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json",
                                                    "Authorization": "Bearer " + os.environ["TWIN_MODEL_API_KEY"],
                                                    "X-OmniRoute-No-Cache": "true"})
        with self.opener.open(request, timeout=timeout) as response:
            data = response.read(131073)
            decision_header = response.headers.get("X-OmniRoute-Decision")
        if len(data) > 131072:
            raise ValueError("oversized model response")
        result = json.loads(data)
        usage = result.get("usage") or {}
        usage["response_model"] = str(result.get("model", "unknown"))[:128]
        usage["route_decision"] = decision_header[:512] if decision_header else None
        # A combo can fail over to another provider. A decision from any other model
        # would silently contaminate this condition, so it becomes a recorded model error.
        if self.expected_upstream and self.expected_upstream not in usage["response_model"].lower():
            raise ValueError(f"upstream model mismatch: expected {self.expected_upstream}, got {usage['response_model']}")
        return json.loads(result["choices"][0]["message"]["content"]), usage


def omniroute_decision_schema() -> dict:
    """Small OpenAPI Schema subset accepted by Gemini's responseSchema bridge.

    This is only an output hint. Decision.model_validate and the tool executor
    enforce the full discriminated action schema after generation.
    """
    return {"type": "object", "properties": {
        "hypothesis": {"type": "string"},
        "action": {"type": "object", "nullable": True, "properties": {
            "name": {"type": "string", "enum": ["inspect_config", "scan_service", "security_check",
                                                "run_nuclei", "http_probe", "tcp_probe", "database_probe",
                                                "http_headers", "redis_config", "ssh_auth_methods", "test_patch",
                                                "company_probe", "company_patch"]},
            "target_id": {"type": "string"}, "port": {"type": "integer"},
            "template": {"type": "string"}, "method": {"type": "string"},
            "path": {"type": "string"}, "redirects": {"type": "integer"},
            "operation": {"type": "string"}, "query": {"type": "string"},
            "authenticated": {"type": "boolean"},
            "parameter": {"type": "string"},
            "policy": {"type": "string"},
            "changes": {"type": "array", "items": {"type": "object", "properties": {
                "field": {"type": "string"}, "index": {"type": "integer"},
                "value": {"type": "string"}, "append_name": {"type": "string", "nullable": True}},
                "required": ["field", "index", "value"]}}},
            "required": ["name", "target_id", "port"]},
        "stop": {"type": "boolean"}},
        "required": ["hypothesis", "action", "stop"]}


def backend() -> str:
    value = os.environ.get("TWIN_MODEL_BACKEND", DEFAULT_BACKEND)
    if value not in {"omniroute", "local"}:
        raise ValueError("TWIN_MODEL_BACKEND must be 'omniroute' or 'local'")
    return value


def model_profile() -> dict:
    """Recorded description of the active model condition (stored with every report)."""
    if backend() == "local":
        return json.loads(Path(os.environ.get("TWIN_MODEL_LOCK", MODELS / "model-lock.json")).read_text(encoding="utf-8"))
    profile = json.loads((MODELS / "model-gemini.json").read_text(encoding="utf-8"))
    profile["requested_model"] = os.environ.get("TWIN_MODEL_ID", profile["requested_model"])
    profile["expected_upstream"] = os.environ.get("TWIN_MODEL_EXPECTED", profile["expected_upstream"])
    profile["context_length"] = int(os.environ.get("TWIN_MODEL_CONTEXT_LENGTH", profile["context_length"]))
    return profile


def configured_model(lock: dict, endpoint: str | None = None, seed: int = 0):
    if backend() == "omniroute":
        profile = model_profile()
        return OmniRouteModel(profile["requested_model"], endpoint or profile["endpoint"], seed,
                              profile["context_length"], profile["expected_upstream"])
    return CompatibleModel(lock, endpoint or "http://127.0.0.1:8000/v1", seed)


class ReplayModel:
    """Boundary test double. Never presented as measured AI performance."""
    identity = {"model": "scripted-test-double", "is_ai": False}

    def __init__(self, decisions):
        self.decisions = iter(decisions)

    def decide(self, *args):
        return next(self.decisions), {"total_tokens": 0}
