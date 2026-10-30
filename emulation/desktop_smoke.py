"""Local Docker Desktop adapter smoke checks; not the Linux isolation gate."""
from __future__ import annotations

import hashlib
import argparse
import json
from pathlib import Path
from uuid import uuid4

import docker

from twin_ingestion.phase2.adapters import CATALOG, render
from twin_ingestion.phase2.engine import LABEL, Sandbox, _label_run
from twin_ingestion.phase2.worker import behavior, sampled_resources


class _NoHostFirewall:
    def cleanup(self):
        pass


class DesktopSmokeSandbox(Sandbox):
    """Exercise renderers on Docker's internal networks without host claims."""

    def __init__(self, client, run_id: str):
        self.docker = client
        self.run_id = run_id
        self.worker_id = "desktop-smoke"
        self.short = _label_run(run_id)
        self.firewall = _NoHostFirewall()
        self.networks = []
        self.containers = []

    def network(self, suffix: str):
        network = self.docker.networks.create(
            f"dt-{self.short}-{suffix}", driver="bridge", internal=True,
            labels={LABEL: self.run_id, "digital-twin.phase2.worker": self.worker_id},
        )
        self.networks.append(network)
        return network


def _clear_previous(client):
    selector = "digital-twin.phase2.worker=desktop-smoke"
    for container in client.containers.list(all=True, filters={"label": selector}):
        container.remove(force=True, v=True)
    for network in client.networks.list(filters={"label": selector}):
        network.remove()


def _fixture(client, fixture: dict, scan: bool = False) -> dict:
    sandbox = DesktopSmokeSandbox(client, str(uuid4()))
    try:
        rendered = render(fixture["service"], fixture["version"], fixture["directives"], fixture.get("hba_rules"))
        if not rendered.supported:
            return {"fixture": fixture["service"] + ":" + fixture["case"], "passed": False,
                    "error": ";".join(rendered.fidelity_gaps)}
        service = {"id": fixture["service"] + ":" + fixture["case"], "kind": fixture["service"],
                   "directives": fixture["directives"], "hba_rules": fixture.get("hba_rules", [])}
        twin, network = sandbox.launch_service(service, rendered)
        sandbox.start_service(twin, rendered)
        ready, detail = sandbox.readiness(twin, fixture["service"])
        if not ready:
            raise RuntimeError(f"readiness failed: {detail}")
        probe = sandbox.probe_container(service["id"], network)
        reachable = sandbox.exec(probe, ["nc", "-z", "-w", "2", twin.name, str(rendered.port)])[0] == 0
        checked = behavior(sandbox, probe, service, twin, rendered.port)
        scans = {}
        if scan:
            code, output = sandbox.exec(probe, ["nmap", "-sT", "-Pn", "-n", "-p",
                                                str(rendered.port), "--max-retries", "1", "--host-timeout", "15s", twin.name])
            scans["nmap_port_open"] = code == 0 and "open" in output
            if not scans["nmap_port_open"]:
                scans["nmap_detail"] = {"exit_code": code, "output": output[-1000:]}
            if fixture["service"] == "nginx":
                code, output = sandbox.exec(probe, ["nuclei", "-t", "/run/twin/nginx-header.yaml",
                    "-u", f"http://{twin.name}:{rendered.port}", "-disable-update-check", "-no-interactsh",
                    "-rate-limit", "2", "-concurrency", "1", "-timeout", "3", "-retries", "0", "-jsonl"])
                scans["nuclei_header"] = code == 0 and '"template-id":"twin-nginx-header"' in output
                if not scans["nuclei_header"]:
                    scans["nuclei_detail"] = output[-1000:]
        cpu, ram = sampled_resources(sandbox.containers)
        budget = {"cpu_millis": CATALOG[fixture["service"]]["cpu_millis"] + 200,
                  "ram_mb": CATALOG[fixture["service"]]["ram_mb"] + 128}
        return {"fixture": service["id"], "expected": fixture["expected"], "observed": checked["verdict"],
                "ready": ready, "tcp_reachable": reachable, "sampled_cpu_millis": cpu, "sampled_ram_mb": ram,
                "budget": budget, "image_id": twin.image.id,
                "scans": scans, "passed": reachable and checked["verdict"] == fixture["expected"] and
                all(value is True for key, value in scans.items() if key not in {"nuclei_detail", "nmap_detail"}) and
                cpu <= budget["cpu_millis"] and ram <= budget["ram_mb"]}
    finally:
        errors = sandbox.cleanup()
        if errors:
            raise RuntimeError(f"cleanup failed: {errors}")


def _chain(client) -> dict:
    sandbox = DesktopSmokeSandbox(client, str(uuid4()))
    try:
        front_id, back_id = "smoke:nginx:front", "smoke:nginx:back"
        back_name = f"dt-{sandbox.short}-{hashlib.sha256(back_id.encode()).hexdigest()[:6]}"
        marker = hashlib.sha256(back_id.encode()).hexdigest()[:12]
        front_config = render("nginx", "1.27.5", [{"order": 1, "name": "proxy_pass",
            "values": ["http://source-backend:8080"], "section": "http/server/location /"}],
            upstream_alias=f"{back_name}:8080", instance_marker="front")
        back_config = render("nginx", "1.27.5", [{"order": 1, "name": "server_tokens", "values": ["off"]}],
                             instance_marker=marker)
        front, front_net = sandbox.launch_service({"id": front_id}, front_config)
        back, _ = sandbox.launch_service({"id": back_id}, back_config)
        link = sandbox.network("link-smoke")
        link.connect(front, aliases=[front.name])
        link.connect(back, aliases=[back.name])
        sandbox.start_service(back, back_config)
        sandbox.start_service(front, front_config)
        ready = sandbox.readiness(front, "nginx")[0] and sandbox.readiness(back, "nginx")[0]
        probe = sandbox.probe_container("smoke:chain", front_net)
        direct_denied = sandbox.exec(probe, ["nc", "-z", "-w", "2", back.name, "8080"])[0] != 0
        code, output = sandbox.exec(probe, ["curl", "-fsS", "--max-time", "4", f"http://{front.name}:8080/"])
        cpu, ram = sampled_resources(sandbox.containers)
        return {"fixture": "nginx-proxy-chain", "ready": ready, "direct_back_denied": direct_denied,
                "backend_marker_seen": f"synthetic twin {marker}" in output, "sampled_cpu_millis": cpu,
                "sampled_ram_mb": ram, "budget": {"cpu_millis": 700, "ram_mb": 384},
                "passed": ready and direct_denied and code == 0 and f"synthetic twin {marker}" in output
                and cpu <= 700 and ram <= 384}
    finally:
        errors = sandbox.cleanup()
        if errors:
            raise RuntimeError(f"cleanup failed: {errors}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", action="append", choices=["nginx", "postgresql", "redis", "openssh"])
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--scan", action="store_true", help="also run bounded Nmap and Nuclei checks")
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("repetitions must be positive")
    fixtures = json.loads((Path(__file__).parent / "fixtures" / "core-behavior.json").read_text(encoding="utf-8"))
    if args.service:
        fixtures = [fixture for fixture in fixtures if fixture["service"] in args.service]
    client = docker.from_env()
    _clear_previous(client)
    results = []
    for repetition in range(1, args.repetitions + 1):
        for fixture in fixtures:
            try:
                results.append({"repetition": repetition, **_fixture(client, fixture, args.scan)})
            except Exception as exc:
                results.append({"repetition": repetition, "fixture": fixture["service"] + ":" + fixture["case"],
                                "passed": False, "error": str(exc)[:3000]})
        if not args.service or "nginx" in args.service:
            try:
                results.append({"repetition": repetition, **_chain(client)})
            except Exception as exc:
                results.append({"repetition": repetition, "fixture": "nginx-proxy-chain", "passed": False,
                                "error": str(exc)[:3000]})
    selector = "digital-twin.phase2.worker=desktop-smoke"
    leftovers = {"containers": len(client.containers.list(all=True, filters={"label": selector})),
                 "networks": len(client.networks.list(filters={"label": selector}))}
    info = client.info()
    print(json.dumps({"scope": "Docker Desktop behavior smoke only; no host/LAN/internet isolation assertion",
                      "docker_engine": client.version()["Version"], "hardware": {"cpus": info["NCPU"],
                      "memory_bytes": info["MemTotal"]}, "leftovers": leftovers,
                      "passed": all(item["passed"] for item in results) and not any(leftovers.values()),
                      "results": results}, indent=2))
    if not all(item["passed"] for item in results) or any(leftovers.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
