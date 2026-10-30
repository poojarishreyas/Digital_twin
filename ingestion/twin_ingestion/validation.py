import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from .models import Envelope


class TelemetryValidator:
    def __init__(self, schema_path: str):
        schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
        self._validator = Draft202012Validator(schema, format_checker=FormatChecker())

    def validate(self, raw: bytes) -> tuple[Envelope, dict]:
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("envelope exceeds 16 MiB")
        data = json.loads(raw)
        errors = sorted(self._validator.iter_errors(data), key=lambda e: list(e.path))
        if errors:
            error = errors[0]
            location = ".".join(map(str, error.absolute_path)) or "$"
            raise ValueError(f"schema validation failed at {location}: {error.message}")
        return Envelope.model_validate(data), data

