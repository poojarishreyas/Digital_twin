"""Scenario-specific typed actions. Kept out of the shared union so other hunts are unchanged."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from ..phase3.contracts import Inspect, Strict, TargetCall


class CustomerApiProbe(TargetCall):
    name: Literal["customer_api_probe"]  # unauthenticated; identifiers are fixed by the executor
    operation: Literal["lookup", "enumerate"]


class CustomerApiPatch(TargetCall):
    name: Literal["customer_api_patch"]
    policy: Literal["require_customer_authorization"]


CustomerAction = Annotated[Inspect | CustomerApiProbe | CustomerApiPatch, Field(discriminator="name")]


class CustomerDecision(Strict):
    hypothesis: str = Field(max_length=1000)
    action: CustomerAction | None
    stop: bool = False
