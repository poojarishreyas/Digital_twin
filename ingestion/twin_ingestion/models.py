from datetime import datetime
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(StrictModel):
    source: str
    observed_at: datetime
    confidence: Literal["observed", "inferred", "confirmed"]


class Host(StrictModel):
    id: str
    hostname: str
    os: Literal["windows", "linux"]
    os_version: str = ""
    architecture: str
    kernel: str = ""
    hardware: dict[str, str] = Field(default_factory=dict)


class Component(StrictModel):
    kind: Literal["service", "listener", "firewall", "privilege", "configuration", "identity", "process"]
    id: str
    hash: str
    archetype_hash: str = ""
    data: dict[str, Any]
    evidence: Evidence


class Relationship(StrictModel):
    kind: Literal["HAS_SERVICE", "HAS_LISTENER", "HAS_FIREWALL", "HAS_PRIVILEGE", "HAS_CONFIGURATION", "HAS_IDENTITY", "HAS_PROCESS", "OBSERVED_CONNECTION", "INFERRED_REACHABILITY", "CONFIRMED_ATTACK_TRANSITION"]
    source_id: str
    target_id: str
    properties: dict[str, Any] = Field(default_factory=dict)
    evidence: Evidence

    @model_validator(mode="after")
    def evidence_matches_semantics(self):
        expected = {"OBSERVED_CONNECTION": "observed", "INFERRED_REACHABILITY": "inferred", "CONFIRMED_ATTACK_TRANSITION": "confirmed"}
        if self.kind in expected and self.evidence.confidence != expected[self.kind]:
            raise ValueError(f"{self.kind} requires {expected[self.kind]} evidence")
        return self


class Gap(StrictModel):
    collector: str
    field: str
    reason: str
    detail: str = ""
    at: datetime


class Metrics(StrictModel):
    collection_ms: int = Field(ge=0)
    cpu_percent: float = Field(ge=0)
    ram_bytes: int = Field(ge=0)
    envelope_bytes: int = Field(ge=0)
    polling_interval_sec: int = Field(ge=1)
    triggered_at: str = ""
    event_to_collect_ms: int = Field(default=0, ge=0)


class Envelope(StrictModel):
    schema_version: Literal["1.0"]
    agent_id: str
    sequence: int = Field(ge=1)
    sent_at: datetime
    full_snapshot: bool
    host: Host
    components: list[Component]
    removed: list[str] = Field(default_factory=list)
    relationships: list[Relationship]
    gaps: list[Gap]
    metrics: Metrics

    @model_validator(mode="after")
    def identity_matches(self):
        if self.agent_id != self.host.id:
            raise ValueError("agent_id must equal host.id")
        ids = [c.id for c in self.components]
        if len(ids) != len(set(ids)):
            raise ValueError("component IDs must be unique within an envelope")
        prefixes = ("service", "listener", "firewall", "privilege", "config", "identity", "process")

        def owned(value, prefix=None):
            for kind in (prefix,) if prefix else prefixes:
                base = f"{kind}:{self.agent_id}"
                if value == base or value.startswith(base + ":"):
                    return True
            return False

        for component in self.components:
            prefix = "config" if component.kind == "configuration" else component.kind
            if not owned(component.id, prefix):
                raise ValueError("component ID is outside the enrolled agent namespace")
            if component.evidence.confidence == "confirmed":
                raise ValueError("passive telemetry cannot submit confirmed evidence")
        if any(not owned(value) for value in self.removed):
            raise ValueError("removed component ID is outside the enrolled agent namespace")
        for relationship in self.relationships:
            if relationship.kind == "CONFIRMED_ATTACK_TRANSITION" or relationship.evidence.confidence == "confirmed":
                raise ValueError("passive telemetry cannot submit confirmed attack evidence")
            if relationship.source_id != self.host.id:
                raise ValueError("relationship source must be the enrolled host")
            if relationship.kind.startswith("HAS_") and not owned(relationship.target_id):
                raise ValueError("structural relationship target is outside the enrolled agent namespace")
        return self

