from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TargetCall(Strict):
    target_id: str = Field(min_length=1, max_length=128)
    port: int = Field(ge=1, le=65535)


class Inspect(TargetCall):
    name: Literal["inspect_config"]


class Scan(TargetCall):
    name: Literal["scan_service"]


class Security(TargetCall):
    name: Literal["security_check"]


class Nuclei(TargetCall):
    name: Literal["run_nuclei"]
    template: Literal["twin-nginx-header"]


class HTTP(TargetCall):
    name: Literal["http_probe"]
    method: Literal["GET", "HEAD"] = "GET"
    path: Literal["/", "/health"] = "/"
    redirects: int = Field(default=0, ge=0, le=2)


class TCP(TargetCall):
    name: Literal["tcp_probe"]
    operation: Literal["connect"] = "connect"


class Database(TargetCall):
    name: Literal["database_probe"]
    query: Literal["select_one"] = "select_one"
    authenticated: bool = False


class HttpHeaders(TargetCall):
    name: Literal["http_headers"]  # read-only: fetch response headers, assess security headers


class RedisConfig(TargetCall):
    name: Literal["redis_config"]  # read-only: CONFIG GET one allowlisted parameter
    parameter: Literal["protected-mode", "bind", "requirepass", "maxmemory-policy", "appendonly"] = "protected-mode"


class SshAuthMethods(TargetCall):
    name: Literal["ssh_auth_methods"]  # read-only: offered auth methods, no authentication


class Edit(Strict):
    field: Literal["directives", "hba_rules"]
    index: int = Field(ge=0, le=100)
    value: str = Field(min_length=1, max_length=128)
    append_name: Literal["requirepass"] | None = None


class Patch(TargetCall):
    name: Literal["test_patch"]
    changes: list[Edit] = Field(min_length=1, max_length=4)


class CompanyProbe(TargetCall):
    name: Literal["company_probe"]
    operation: Literal["ordinary", "restricted"]


class CompanyPatch(TargetCall):
    name: Literal["company_patch"]
    policy: Literal["enforce_record_authorization"]


Action = Annotated[Inspect | Scan | Security | Nuclei | HTTP | TCP | Database | HttpHeaders | RedisConfig | SshAuthMethods | Patch | CompanyProbe | CompanyPatch, Field(discriminator="name")]
ACTION = TypeAdapter(Action)


class Decision(Strict):
    hypothesis: str = Field(max_length=1000)
    action: Action | None
    stop: bool = False


class Limits(Strict):
    max_steps: int = Field(default=12, ge=1, le=32)
    max_tokens: int = Field(default=32768, ge=1024, le=131072)
    response_tokens: int = Field(default=512, ge=64, le=2048)
    max_seconds: int = Field(default=180, ge=5, le=600)
    timeout_seconds: int = Field(default=5, ge=1, le=10)
    requests_per_second: float = Field(default=2.0, gt=0, le=5)


class RegistryTarget(Strict):
    id: str
    host: str
    ip: str
    port: int
    kind: Literal["nginx", "postgresql", "redis", "openssh"]
    snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    image_id: str
    fidelity_gaps: list[str]


class Report(Strict):
    schema_version: Literal["3.0"] = "3.0"
    run_id: str = Field(pattern=r"^[a-f0-9-]{36}$")
    created_at: str
    mode: Literal["linux_isolated", "desktop_smoke"]
    manifest_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    model_lock: dict
    budgets: dict
    environment: dict
    rows: list[dict]
    patches: list[dict] = []
    limitations: list[str]
