from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
from uuid import uuid4
import docker

from ..phase2.adapters import CATALOG, render
from ..phase2.engine import Sandbox
from ..sanitize import sanitize
from .contracts import RegistryTarget, digest


class Unsupported(RuntimeError):
    pass


class ResourceSampler:
    def __init__(self, sandbox):
        self.sandbox = sandbox
        self.stop = threading.Event()
        self.metrics = {"peak_ram_mb": 0.0, "peak_cpu_millis": 0.0, "cpu_seconds": 0.0,
                        "ram_mb_seconds": 0.0, "sample_interval_seconds": 0.5, "sample_errors": 0}
        self.previous = {}
        self.last_sample = time.monotonic()
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def _collect(self):
        now = time.monotonic()
        dt = max(now - self.last_sample, 0.001)
        memory = cpu = 0
        for container in tuple(self.sandbox.containers):
            try:
                stats = container.stats(stream=False, one_shot=True)
                memory += stats.get("memory_stats", {}).get("usage", 0) / 1048576
                total = stats.get("cpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0)
                delta = max(0, total - self.previous.get(container.id, 0)) / 1e9
                cpu += delta
                self.metrics["cpu_seconds"] += delta
                self.previous[container.id] = total
            except Exception:
                self.metrics["sample_errors"] += 1
        self.metrics["peak_ram_mb"] = max(self.metrics["peak_ram_mb"], memory)
        self.metrics["peak_cpu_millis"] = max(self.metrics["peak_cpu_millis"], 1000 * cpu / dt)
        self.metrics["ram_mb_seconds"] += memory * dt
        self.last_sample = now

    def _loop(self):
        while not self.stop.is_set():
            self._collect()
            self.stop.wait(0.5)

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=10)
        if self.thread.is_alive():
            self.metrics["sample_errors"] += 1
        else:
            self._collect()
        return dict(self.metrics)


def clean_state(service: dict) -> dict:
    result = {k: service[k] for k in ("id", "kind", "version")}
    result["directives"] = []
    for directive in service.get("directives", []):
        d = {k: copy.deepcopy(directive[k]) for k in ("order", "name", "values", "section") if k in directive}
        policy = d["name"].lower() in {"passwordauthentication", "password_encryption", "pubkeyauthentication"}
        if not policy and any(x in d["name"].lower() for x in ("password", "requirepass", "secret", "credential")):
            d["values"] = ["<redacted>"]
        result["directives"].append(sanitize(d))
    result["hba_rules"] = [sanitize({k: copy.deepcopy(rule[k]) for k in ("order", "name", "values") if k in rule})
                           for rule in service.get("hba_rules", [])]
    return result


class Lab:
    """One immutable source snapshot, disposable containers, one registry."""
    def __init__(self, scenario: dict, mode: str, destinations: dict | None = None, worker_id=None):
        self.scenario = copy.deepcopy(scenario)
        self.snapshot_hash = digest(scenario)
        self.mode = mode
        self.client = docker.from_env(timeout=15)
        self.run_id = str(uuid4())
        if mode == "desktop_smoke":
            from emulation.desktop_smoke import DesktopSmokeSandbox
            self.sandbox = DesktopSmokeSandbox(self.client, self.run_id)
            self.sandbox.worker_id = worker_id or "phase3-smoke"
        elif mode == "linux_isolated":
            self.sandbox = Sandbox(self.client, self.run_id, worker_id or "phase3-lab", destinations or {})
        else:
            raise ValueError("explicit lab mode required")
        self.instances, self.probes, self.registry, self.rendered = {}, {}, {}, {}
        self.sampler = ResourceSampler(self.sandbox)
        self.metrics = {}
        self.readiness_seconds = 0
        self.cleanup_errors = []

    def __enter__(self):
        started = time.monotonic()
        try:
            services = self.scenario["services"]
            if len(services) > 4:
                raise Unsupported("at most four co-scheduled dependency services")
            cpu = sum(CATALOG[s["kind"]]["cpu_millis"] + 200 for s in services)
            ram = sum(CATALOG[s["kind"]]["ram_mb"] + 128 for s in services)
            if cpu > 2000 or ram > 2048:
                raise Unsupported("scenario exceeds fixed 2000m CPU / 2048MB budget")
            if self.mode == "linux_isolated" and not all(self.sandbox.positive_controls().values()):
                raise RuntimeError("host/LAN/internet positive controls unavailable")
            self.sampler.thread.start()
            for service in services:
                upstream = None
                if service.get("upstream"):
                    name = hashlib.sha256(service["upstream"].encode()).hexdigest()[:6]
                    upstream = f"dt-{self.sandbox.short}-{name}:8080"
                configured = render(service["kind"], service["version"], service.get("directives", []),
                                    service.get("hba_rules"), service.get("unsupported"), upstream,
                                    hashlib.sha256(service["id"].encode()).hexdigest()[:12])
                self.rendered[service["id"]] = configured
                if not configured.supported:
                    raise Unsupported(";".join(configured.fidelity_gaps))
                self.instances[service["id"]] = self.sandbox.launch_service(service, configured)
            for index, link in enumerate(self.scenario.get("links", [])):
                network = self.sandbox.network(f"link-{index}")
                for target_id in link:
                    container = self.instances[target_id][0]
                    network.connect(container, aliases=[container.name])
            for service in reversed(services):
                self.sandbox.start_service(self.instances[service["id"]][0], self.rendered[service["id"]])
            for service in services:
                target_id = service["id"]
                container, network = self.instances[target_id]
                ready, detail = self.sandbox.readiness(container, service["kind"])
                if not ready:
                    raise RuntimeError("startup/syntax check failed: " + detail[:500])
                probe = self.sandbox.probe_container(target_id, network)
                self.probes[target_id] = probe
                container.reload()
                ip = container.attrs["NetworkSettings"]["Networks"][network.name]["IPAddress"]
                self.registry[target_id] = RegistryTarget(id=target_id, host=container.name, ip=ip,
                    port=self.rendered[target_id].port, kind=service["kind"], snapshot_hash=self.snapshot_hash,
                    image_id=container.image.id, fidelity_gaps=self.rendered[target_id].fidelity_gaps)
                if self.mode == "linux_isolated":
                    check = self.sandbox.isolation(probe, container.name, self.rendered[target_id].port)
                    if not check["passed"]:
                        raise RuntimeError("isolation prerequisites failed")
            self.readiness_seconds = time.monotonic() - started
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def command(self, target_id, command: list[str], timeout=5):
        # The Docker daemon does not expose an exec deadline. BusyBox timeout
        # kills the process inside the probe; there is never a model shell tool.
        return self.sandbox.exec(self.probes[target_id], ["timeout", "-s", "KILL", str(timeout), *command])

    def service(self, target_id):
        return next(s for s in self.scenario["services"] if s["id"] == target_id)

    def state(self):
        return {"targets": [t.model_dump() for t in self.registry.values()],
                "configurations": [clean_state(s) for s in self.scenario["services"]],
                "limitations": ["synthetic accounts and data", "findings apply only to tested twins", self.mode]}

    def __exit__(self, *args):
        if self.sampler.thread.ident:
            self.metrics = self.sampler.finish()
        self.cleanup_errors = self.sandbox.cleanup()
        self.client.close()
        if self.cleanup_errors:
            raise RuntimeError("cleanup failed: " + ",".join(self.cleanup_errors))
