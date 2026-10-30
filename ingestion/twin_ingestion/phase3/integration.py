"""Attach hunting to an already isolated Phase 2 wave without extra probe containers."""
import copy
import json
import os
from pathlib import Path
from .contracts import Limits, RegistryTarget
from .hunter import hunt
from .model import configured_model, model_profile
from .runtime import Lab
from .tools import ToolExecutor


class AttachedLab:
    service = Lab.service
    state = Lab.state
    command = Lab.command

    def __init__(self, sandbox, service, selected, container, network, probe, rendered):
        self.sandbox = sandbox
        self.mode = "linux_isolated"
        self.scenario = {"test": service["kind"] + ".policy", "services": [copy.deepcopy(service)] +
                         [copy.deepcopy(s) for s in selected if s["id"] != service["id"]], "links": []}
        self.probes = {service["id"]: probe}
        container.reload()
        ip = container.attrs["NetworkSettings"]["Networks"][network.name]["IPAddress"]
        self.registry = {service["id"]: RegistryTarget(id=service["id"], host=container.name, ip=ip,
            port=rendered.port, kind=service["kind"], snapshot_hash=service["snapshot_hash"],
            image_id=container.image.id, fidelity_gaps=rendered.fidelity_gaps)}


def run_attached_hunt(sandbox, service, selected, container, network, probe, rendered, remaining_tokens):
    lock = model_profile()
    if remaining_tokens < 1024:
        return {"status": "run_token_limit", "reserved_tokens": 0, "reported_tokens": None, "trace": [], "evidence": [], "patches": []}
    limits = Limits(max_tokens=min(32768, remaining_tokens))
    lab = AttachedLab(sandbox, service, selected, container, network, probe, rendered)
    tools = ToolExecutor(lab, limits)
    # An active wave has no reservation for additional candidate containers.
    # Disposable patch verification runs separately through the benchmark
    # runner, whose fixed budget admits an original plus one single-service copy.
    model = configured_model(lock, os.environ.get("TWIN_MODEL_ENDPOINT"))
    state = lab.state()
    state["limitations"].append("test_patch unavailable during an active graph wave; use a separately budgeted verification run")
    return hunt(model, tools, state, limits)
