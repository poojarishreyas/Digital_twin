"""Docker worker restricted to a dedicated Linux sandbox host."""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from .adapters import CATALOG, Rendered, render

LABEL = "digital-twin.phase2.run"
TENANT_LABEL = "digital-twin.tenant"
PROBE_IMAGE = "twin-probe:phase2-local"


def _label_run(run_id: str) -> str:
    value = re.sub(r"[^a-z0-9]", "", run_id.lower())[:12]
    if not value:
        raise ValueError("invalid run ID")
    return value


def _install_files(container, files: dict[str, str]):
    """Write small rendered configs into /run tmpfs without host mounts."""
    for name, content in files.items():
        if Path(name).name != name or name.startswith("."):
            raise ValueError("invalid config filename")
        data = content.encode("utf-8")
        if len(data) > 131072:
            raise ValueError("rendered config exceeds 128 KiB")
        encoded = base64.b64encode(data).decode("ascii")
        result = container.exec_run(["sh", "-c", "printf %s \"$1\" | base64 -d > \"$2\"", "sh",
                                     encoded, "/run/twin/" + name], user="0")
        if result.exit_code != 0:
            raise RuntimeError(f"unable to install rendered config: {name}")


class Firewall:
    """Host rules add a second boundary around Docker internal networks."""
    def __init__(self):
        if platform.system() != "Linux" or os.geteuid() != 0:
            raise RuntimeError("Phase 2 orchestration requires a dedicated Linux root service")
        subprocess.run(["iptables", "-S", "DOCKER-USER"], check=True, capture_output=True)
        self.bridges: list[str] = []

    def protect(self, bridge: str):
        if not re.fullmatch(r"dt[a-f0-9]{10}", bridge):
            raise ValueError("unexpected bridge name")
        rules = [["INPUT", "-i", bridge, "-j", "DROP"],
                 ["DOCKER-USER", "-i", bridge, "!", "-o", bridge, "-j", "DROP"]]
        inserted = []
        try:
            for rule in rules:
                subprocess.run(["iptables", "-I", *rule], check=True, capture_output=True)
                inserted.append(rule)
        except Exception:
            for rule in reversed(inserted):
                subprocess.run(["iptables", "-D", *rule], check=False, capture_output=True)
            raise
        self.bridges.append(bridge)

    def cleanup(self):
        for bridge in reversed(self.bridges):
            for rule in (["INPUT", "-i", bridge, "-j", "DROP"],
                         ["DOCKER-USER", "-i", bridge, "!", "-o", bridge, "-j", "DROP"]):
                subprocess.run(["iptables", "-D", *rule], check=False, capture_output=True)
        self.bridges.clear()


class Sandbox:
    def __init__(self, docker_client, run_id: str, worker_id: str, destinations: dict[str, dict], tenant_id: str = "default"):
        if platform.system() != "Linux":
            raise RuntimeError("Phase 2 sandbox is Linux only")
        if set(destinations) != {"host", "lan", "internet"}:
            raise ValueError("host, lan, and internet test destinations are required")
        self.destinations = {}
        for name, value in destinations.items():
            ip = str(ipaddress.ip_address(value["ip"]))
            port = int(value["port"])
            if not 1 <= port <= 65535:
                raise ValueError("test destination port out of range")
            self.destinations[name] = {"ip": ip, "port": port}
        self.docker = docker_client
        self.run_id = run_id
        self.worker_id = worker_id
        self.short = _label_run(run_id)
        # Every twin network/container is attributable to exactly one tenant's run.
        self.tenant_id = tenant_id
        self.firewall = Firewall()
        self.networks = []
        self.containers = []

    def network(self, suffix: str):
        name = f"dt-{self.short}-{suffix}"
        bridge = f"dt{self.short[:10]}"  # overridden below to remain unique per network
        import hashlib
        bridge = "dt" + hashlib.sha256(name.encode()).hexdigest()[:10]
        network = self.docker.networks.create(
            name, driver="bridge", internal=True, check_duplicate=True,
            labels={LABEL: self.run_id, TENANT_LABEL: self.tenant_id, "digital-twin.phase2.worker": self.worker_id}, options={"com.docker.network.bridge.name": bridge},
        )
        self.networks.append(network)
        try:
            self.firewall.protect(bridge)
        except Exception:
            network.remove()
            self.networks.remove(network)
            raise
        return network

    def launch(self, name: str, image: str, network, environment=None,
               memory_mb: int = 128, cpu_millis: int = 250, user: str | None = None):
        container = self.docker.containers.create(
            image=image, name=name, entrypoint=["sleep"], command=["infinity"], environment=environment or {}, network=network.name,
            detach=True, read_only=True, tmpfs={"/tmp": "rw,noexec,nosuid,size=16m",
                                              "/run": "rw,noexec,nosuid,size=16m", "/var/lib/postgresql/data": "rw,nosuid,size=256m",
                                              "/var/cache/nginx": "rw,nosuid,size=16m", "/data": "rw,nosuid,size=16m"},
            mem_limit=f"{memory_mb}m", nano_cpus=cpu_millis * 1_000_000, pids_limit=128,
            cap_drop=["NET_ADMIN", "NET_RAW", "SYS_ADMIN"], security_opt=["no-new-privileges:true"],
            labels={LABEL: self.run_id, TENANT_LABEL: self.tenant_id, "digital-twin.phase2.worker": self.worker_id}, user=user,
        )
        self.containers.append(container)
        return container

    def prepare_runtime(self, container):
        container.start()
        result = container.exec_run(["mkdir", "-p", "/run/twin", "/run/sshd"], user="0")
        if result.exit_code != 0:
            raise RuntimeError("unable to prepare runtime tmpfs")

    def launch_service(self, service: dict, rendered: Rendered):
        import hashlib
        suffix = hashlib.sha256(service["id"].encode()).hexdigest()[:6]
        net = self.network("probe-" + suffix)
        name = f"dt-{self.short}-{suffix}"
        image = rendered.image
        if rendered.service == "openssh":
            image = "twin-openssh:9.9p2-local"
        container = self.launch(name, image, net,
                                environment=rendered.environment, memory_mb=CATALOG[rendered.service]["ram_mb"],
                                cpu_millis=CATALOG[rendered.service]["cpu_millis"])
        self.prepare_runtime(container)
        if rendered.files:
            _install_files(container, rendered.files)
        return container, net

    def start_service(self, container, rendered: Rendered):
        service_command = rendered.command
        if rendered.service == "postgresql":
            service_command = ["sh", "-c", "exec docker-entrypoint.sh postgres -c config_file=/run/twin/postgresql.conf > /run/twin/service.log 2>&1"]
        container.exec_run(service_command or ["sh", "-c", "ssh-keygen -q -t ed25519 -N '' -f /run/twin/ssh_host_ed25519_key && exec /usr/sbin/sshd -D -e -f /run/twin/sshd_config"], detach=True)

    def readiness(self, container, service: str) -> tuple[bool, str]:
        commands = {
            "nginx": ["nginx", "-t", "-c", "/run/twin/nginx.conf"],
            "postgresql": ["pg_isready", "-h", "127.0.0.1", "-p", "5432"],
            "redis": ["redis-cli", "-h", "127.0.0.1", "ping"],
            "openssh": ["/usr/sbin/sshd", "-t", "-f", "/run/twin/sshd_config"],
        }
        last = ""
        for _ in range(60 if service == "postgresql" else 20):
            container.reload()
            if container.status != "running":
                return False, f"container_{container.status}"
            result = container.exec_run(commands[service])
            last = result.output.decode("utf-8", "replace")[:500]
            if result.exit_code == 0:
                return True, last
            time.sleep(1)
        if service == "postgresql":
            result = container.exec_run(["cat", "/run/twin/service.log"])
            if result.exit_code == 0:
                last += " " + result.output.decode("utf-8", "replace")[-3000:]
        return False, last

    def probe_container(self, target_id: str, network):
        import hashlib
        suffix = hashlib.sha256(target_id.encode()).hexdigest()[:6]
        probe = self.launch(f"dt-{self.short}-probe-{suffix}", PROBE_IMAGE, network,
                            environment={"HOME": "/tmp", "XDG_CONFIG_HOME": "/tmp", "XDG_CACHE_HOME": "/tmp"},
                            memory_mb=128, cpu_millis=200, user="65534:65534")
        self.prepare_runtime(probe)
        template = (Path(__file__).resolve().parents[3] / "emulation" / "templates" / "nginx-header.yaml")
        if template.exists():
            _install_files(probe, {"nginx-header.yaml": template.read_text(encoding="utf-8")})
        return probe

    def remove_container(self, container):
        container.remove(force=True, v=True)
        self.containers.remove(container)

    def exec(self, container, command: list[str]) -> tuple[int, str]:
        result = container.exec_run(command, demux=False)
        return result.exit_code, result.output.decode("utf-8", "replace")[:4000]

    def isolation(self, probe, target_name: str, target_port: int, denied_name: str | None = None) -> dict:
        allowed = self.exec(probe, ["nc", "-z", "-w", "2", target_name, str(target_port)])[0] == 0
        denied = {}
        for category, address in self.destinations.items():
            denied[category] = self.exec(probe, ["nc", "-z", "-w", "2", address["ip"], str(address["port"])])[0] != 0
        if denied_name:
            denied["unlinked_twin"] = self.exec(probe, ["nc", "-z", "-w", "2", denied_name, str(target_port)])[0] != 0
        return {"allowed": allowed, "denied": denied, "passed": allowed and all(denied.values())}

    def positive_controls(self) -> dict[str, bool]:
        result = {}
        for category, address in self.destinations.items():
            try:
                with socket.create_connection((address["ip"], address["port"]), timeout=2):
                    result[category] = True
            except OSError:
                result[category] = False
        return result

    def cleanup(self):
        errors = []
        for container in reversed(self.containers):
            try:
                container.remove(force=True, v=True)
            except Exception as exc:
                errors.append(type(exc).__name__)
        for network in reversed(self.networks):
            try:
                network.remove()
            except Exception as exc:
                errors.append(type(exc).__name__)
        self.firewall.cleanup()
        return errors


def reconcile_labeled(docker_client, worker_id: str):
    """Remove leftovers after an interrupted process before accepting another run."""
    selector = f"digital-twin.phase2.worker={worker_id}"
    for container in docker_client.containers.list(all=True, filters={"label": selector}):
        container.remove(force=True, v=True)
    for network in docker_client.networks.list(filters={"label": selector}):
        bridge = (network.attrs.get("Options") or {}).get("com.docker.network.bridge.name")
        if bridge and re.fullmatch(r"dt[a-f0-9]{10}", bridge):
            for rule in (["INPUT", "-i", bridge, "-j", "DROP"],
                         ["DOCKER-USER", "-i", bridge, "!", "-o", bridge, "-j", "DROP"]):
                subprocess.run(["iptables", "-D", *rule], check=False, capture_output=True)
        network.remove()

