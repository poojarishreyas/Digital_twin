"""Synthetic OmniRoute compatibility check; does not contact lab twins."""
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "ingestion"))

from twin_ingestion.phase3.contracts import Decision  # noqa: E402
from twin_ingestion.phase3.model import OmniRouteModel, model_profile  # noqa: E402


def main():
    os.environ.setdefault("TWIN_MODEL_BACKEND", "omniroute")
    profile = model_profile()
    model = OmniRouteModel(profile["requested_model"], os.environ.get("TWIN_MODEL_ENDPOINT", profile["endpoint"]),
                           context_length=profile["context_length"], expected_upstream=profile["expected_upstream"])
    try:
        raw, usage = model.decide([
            {"role": "system", "content": "Return a JSON object matching the supplied schema. No tool action is needed."},
            {"role": "user", "content": "Synthetic smoke check: say ready, set action to null and stop to true."},
        ], Decision.model_json_schema(), 512, 30)
    except HTTPError as exc:
        body = exc.read(4096).decode("utf-8", errors="replace")
        try:
            error = json.loads(body).get("error", {})
            if not isinstance(error, dict):
                error = {"message": str(error)}
        except ValueError:
            error = {"message": body}
        # Gateway diagnostics can echo request details. Never print the key.
        def safe(value, limit):
            return str(value).replace(os.environ["TWIN_MODEL_API_KEY"], "<redacted>")[:limit]
        raise SystemExit(json.dumps({"status": "gateway_error", "http_status": exc.code,
                                     "error_type": safe(error.get("type", ""), 80),
                                     "error_code": safe(error.get("code", ""), 80),
                                     "message": safe(error.get("message", ""), 500)})) from None
    decision = Decision.model_validate(raw)
    if decision.action is not None or not decision.stop:
        raise SystemExit("Model response passed schema but did not follow the synthetic stop request")
    print(json.dumps({"status": "ok", "requested_model": model.identity["requested_model"],
                      "response_model": usage.get("response_model"),
                      "route_decision": usage.get("route_decision"),
                      "reported_tokens": usage.get("total_tokens")}, indent=2))


if __name__ == "__main__":
    main()
