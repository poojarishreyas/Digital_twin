"""Disposable patch verification; never writes source hosts or source snapshots."""
from __future__ import annotations

import copy
import difflib
import json
import subprocess
import sys
import time
from uuid import uuid4
import docker

from .contracts import Edit, Limits, digest
from .runtime import Lab
from .tools import ToolExecutor


def apply_changes(scenario, target_id, changes):
    candidate = copy.deepcopy(scenario)
    service = next(s for s in candidate["services"] if s["id"] == target_id)
    for raw in changes:
        edit = Edit.model_validate(raw)
        field = service.setdefault(edit.field, [])
        if edit.index == len(field) and edit.field == "directives" and edit.append_name == "requirepass" and service["kind"] == "redis":
            if edit.value != "<redacted>":
                raise ValueError("only synthetic credential substitution is supported")
            field.append({"order": max([d.get("order", 0) for d in field] + [0]) + 1,
                          "name": "requirepass", "values": ["<redacted>"]})
        elif edit.index < len(field) and edit.append_name is None:
            if edit.field == "hba_rules":
                if edit.value not in {"trust", "reject", "md5", "scram-sha-256"}:
                    raise ValueError("unsupported HBA authentication method")
                field[edit.index]["values"][-1] = edit.value
            else:
                if field[edit.index]["name"] == "requirepass" and edit.value != "<redacted>":
                    raise ValueError("only synthetic credential substitution is supported")
                field[edit.index]["values"] = [edit.value]
        else:
            raise ValueError("patch index or append operation invalid")
    return candidate


def verify(scenario, target_id, changes, mode, destinations=None, job_id=None):
    started = time.monotonic()
    result = {"source_snapshot": digest(scenario), "target_id": target_id, "changes": changes,
              "label": "rejected", "checks": {}, "limitations": [mode, "synthetic workflow only; no production compatibility or downtime claim"],
              "rollback": {"source_snapshot": digest(scenario), "configuration": copy.deepcopy(scenario["services"])}}
    try:
        if len(scenario["services"]) != 1:
            raise ValueError("patch verification currently supports single-service scenarios")
        candidate = apply_changes(scenario, target_id, changes)
        result["candidate_snapshot"] = digest(candidate)
        result["diff"] = "".join(difflib.unified_diff(json.dumps(scenario["services"], indent=2).splitlines(True),
            json.dumps(candidate["services"], indent=2).splitlines(True), fromfile="source", tofile="candidate"))
        with Lab(scenario, mode, destinations, worker_id=job_id) as original:
            tools = ToolExecutor(original, Limits(max_steps=12))
            target = original.registry[target_id]
            initial = tools.security(target)
            result["checks"]["original_security"] = initial
            result["checks"]["original_workflow"] = tools.legitimate(target)
            result["source_image_id"] = target.image_id
            result["fidelity_gaps"] = target.fidelity_gaps
            result["rollback"]["rendered_files"] = original.rendered[target_id].files
        with Lab(candidate, mode, destinations, worker_id=job_id) as twin:
            tools = ToolExecutor(twin, Limits(max_steps=12))
            target = twin.registry[target_id]
            result["candidate_image_id"] = target.image_id
            result["checks"]["syntax_and_startup"] = True
            result["checks"]["security_retest"] = tools.security(target)
            result["checks"]["legitimate_workflow"] = tools.legitimate(target)
            result["fidelity_gaps"] += target.fidelity_gaps
            if (initial["verdict"] == "confirmed" and result["checks"]["original_workflow"]
                    and result["checks"]["security_retest"]["verdict"] == "not_reproduced"
                    and result["checks"]["legitimate_workflow"]):
                result["label"] = "verified in the tested twin scenario"
        result["checks"]["cleanup"] = True
    except Exception as exc:
        result["error"] = str(exc)[:1000]
        result["checks"].setdefault("syntax_and_startup", False)
    result["elapsed_seconds"] = time.monotonic() - started
    result["artifact_hash"] = digest(result)
    return result


def bounded_verify(scenario, target_id, changes, mode, destinations=None, timeout=120):
    job_id = "phase3-patch-" + uuid4().hex
    request = dict(scenario=scenario, target_id=target_id, changes=changes, mode=mode,
                   destinations=destinations, job_id=job_id)
    try:
        completed = subprocess.run([sys.executable, "-m", "twin_ingestion.phase3.patches"],
            input=json.dumps(request), text=True, capture_output=True, timeout=timeout, check=True)
        return json.loads(completed.stdout)
    except subprocess.TimeoutExpired:
        return {"label": "rejected", "reason": "patch timeout", "source_snapshot": digest(scenario),
                "target_id": target_id, "changes": changes, "rollback": scenario["services"]}
    finally:
        # Terminated verifier processes cannot run their finally blocks.
        client = docker.from_env(timeout=10)
        if mode == "linux_isolated":
            from ..phase2.engine import reconcile_labeled
            reconcile_labeled(client, job_id)
        else:
            selector = "digital-twin.phase2.worker=" + job_id
            for container in client.containers.list(all=True, filters={"label": selector}):
                container.remove(force=True, v=True)
            for network in client.networks.list(filters={"label": selector}):
                network.remove()
        client.close()


if __name__ == "__main__":
    request = json.loads(sys.stdin.read(262144))
    print(json.dumps(verify(**request)))
