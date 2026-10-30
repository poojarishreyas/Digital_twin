from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from ..phase3.contracts import digest


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Artifact(Strict):
    """Deployment input, not an arbitrary Compose file or executable command."""
    schema_version: Literal["company.1"] = "company.1"
    application: Literal["company-records"] = "company-records"
    release: Literal["1.0.0"] = "1.0.0"
    node_image: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    database_image: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    authorization: Literal["authentication_only", "enforced"] = "authentication_only"
    source_agents: dict[Literal["employee", "gateway", "api", "database"], str]
    links: list[list[str]] = Field(default_factory=lambda: [
        ["employee", "gateway"], ["gateway", "api"], ["api", "database"]])

    @model_validator(mode="after")
    def topology(self):
        roles = {"employee", "gateway", "api", "database"}
        if set(self.source_agents) != roles or len(set(self.source_agents.values())) != 4:
            raise ValueError("four distinct source agent identities required")
        if any(not 16 <= len(v) <= 128 or not all(c.isalnum() or c in "-_" for c in v)
               for v in self.source_agents.values()):
            raise ValueError("invalid source agent identity")
        if self.links != [["employee", "gateway"], ["gateway", "api"], ["api", "database"]]:
            raise ValueError("unsupported dependency topology")
        return self

    @property
    def artifact_id(self):
        return digest(self.model_dump())


class QueueRequest(Strict):
    artifact_id: str = Field(pattern=r"^[a-f0-9]{64}$")


def discover(artifact: Artifact, snapshot: dict):
    """Require actual native-agent service/listener/config and socket evidence."""
    nodes = {n["id"]: n for n in snapshot["nodes"]}
    edges = snapshot["edges"]
    import json
    from datetime import datetime, timezone
    services = {}
    for role, agent in artifact.source_agents.items():
        host = nodes.get(agent)
        if not host or "Host" not in host.get("labels", []):
            raise ValueError("source host has not been discovered")
        seen = host["properties"].get("last_seen", "")
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(seen.replace("Z", "+00:00"))).total_seconds()
            if not -60 <= age <= 180:
                raise ValueError("stale source")
        except (TypeError, ValueError):
            raise ValueError("source telemetry is stale or missing") from None
        service = nodes.get(f"service:{agent}:company-{role}")
        config = nodes.get(f"config:{agent}:workload")
        listener = nodes.get(f"listener:{agent}:workload")
        if not service or not config or not listener:
            raise ValueError("source workload has not been discovered")
        data = json.loads(service["properties"].get("data_json", "{}"))
        configuration = json.loads(config["properties"].get("data_json", "{}"))
        expected = artifact.database_image if role == "database" else artifact.node_image
        if data.get("image_id") != expected or data.get("version") != "company-records/1.0.0":
            raise ValueError("deployment artifact differs from discovered release")
        if role == "api" and configuration.get("authorization") != artifact.authorization:
            raise ValueError("deployment policy differs from discovered configuration")
        services[role] = {"agent_id": agent, "service": service["id"], "image_id": expected,
                          "configuration_hash": config["properties"]["hash"]}
    path = [artifact.source_agents[r] for r in ("employee", "gateway", "api", "database")]
    observed = {(e["source"], e["target"]) for e in edges if e["kind"] == "OBSERVED_CONNECTION"
                and e.get("properties", {}).get("resolution") == "unique_enrolled_workload_listener"}
    if not all((a, b) in observed for a, b in zip(path, path[1:])):
        raise ValueError("complete observed source path is not available")
    return {"path": path, "services": services, "snapshot_hash": digest(snapshot),
            "assumption": "employee client already compromised; employee credential assumed available",
            "evidence_kind": "native_agent_discovery_and_observed_socket_connections"}
