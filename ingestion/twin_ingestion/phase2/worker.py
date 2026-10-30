"""Run queued waves on the dedicated Linux sandbox host."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import hashlib
import signal
from pathlib import Path
from uuid import UUID

import asyncpg
import docker

from .adapters import CATALOG, render
from .engine import Sandbox, PROBE_IMAGE, reconcile_labeled
from .store import RunStore
from ..sanitize import sanitize

LOG = logging.getLogger("twin.phase2.worker")
TEST_VERSIONS = {"nmap": "7.95", "nuclei": "3.11.1", "nginx": "1.0", "postgresql": "1.0", "redis": "1.0", "openssh": "1.0"}


def _finding(service: dict, image_id: str, test_id: str, verdict: str,
             observations: dict, gaps: list[str], prerequisites: dict | None = None) -> dict:
    return {
        "target_id": service["id"], "snapshot_hash": service["snapshot_hash"], "image_id": image_id,
        "test_id": test_id, "test_version": TEST_VERSIONS.get(test_id.split(".")[0], "1.0"),
        "prerequisites": prerequisites or {}, "observations": sanitize(observations),
        "verdict": verdict, "fidelity_gaps": gaps,
    }


def behavior(sandbox: Sandbox, probe, service: dict, container, port: int) -> dict:
    kind = service["kind"]
    target = container.name
    directives = {d.get("name", "").lower(): (d.get("values") or [""])[0] for d in service.get("directives", [])}
    if kind == "nginx":
        code, output = sandbox.exec(probe, ["curl", "-sS", "-i", "--max-time", "4", f"http://{target}:{port}/"])
        header = next((line for line in output.splitlines() if line.lower().startswith("server:")), "")
        configured = directives.get("server_tokens")
        exposed = bool(__import__("re").search(r"nginx/[0-9]", header))
        if code:
            verdict = "inconclusive"
        elif configured not in {"on", "off"}:
            verdict = "confirmed" if " 200 " in output else "inconclusive"
        elif configured == "on":
            verdict = "confirmed" if exposed else "inconclusive"
        else:
            verdict = "not_reproduced" if not exposed else "inconclusive"
        return {"test_id": "nginx.version_header" if configured in {"on", "off"} else "nginx.http_response", "verdict": verdict,
                "observations": {"exit_code": code, "server_header": header, "http_ok": " 200 " in output}}
    if kind == "postgresql":
        code, output = sandbox.exec(probe, ["env", "PGPASSWORD=", "psql", "-w", "-h", target,
                                            "-p", str(port), "-U", "synthetic", "-d", "synthetic", "-tAc", "SELECT 1"])
        rules = sorted(service.get("hba_rules", []), key=lambda d: d.get("order", 0))
        method = (rules[0].get("values") or [""])[-1] if rules else ""
        if method == "trust":
            verdict = "confirmed" if code == 0 and output.strip() == "1" else "inconclusive"
        elif method in {"reject", "scram-sha-256", "md5"}:
            auth_denied = any(message in output.lower() for message in ("no password supplied", "rejects connection", "password authentication failed"))
            verdict = "not_reproduced" if code != 0 and auth_denied else "inconclusive"
        else:
            verdict = "unsupported"
        return {"test_id": "postgresql.trust_access", "verdict": verdict,
                "observations": {"exit_code": code, "query_returned_one": output.strip() == "1", "method": method}}
    if kind == "redis":
        code, output = sandbox.exec(probe, ["redis-cli", "-h", target, "-p", str(port), "--raw", "PING"])
        protected = directives.get("protected-mode")
        auth_required = "requirepass" in directives
        accepted = code == 0 and output.strip() == "PONG"
        if auth_required:
            verdict = "not_reproduced" if not accepted and "NOAUTH" in output.upper() else "inconclusive"
        elif protected == "no":
            verdict = "confirmed" if accepted else "inconclusive"
        elif protected == "yes":
            verdict = "not_reproduced" if not accepted and "DENIED" in output.upper() else "inconclusive"
        else:
            verdict = "inconclusive"
        return {"test_id": "redis.unauthenticated_ping", "verdict": verdict,
                "observations": {"exit_code": code, "accepted": accepted, "denied": "DENIED" in output.upper(), "authentication_required": auth_required}}
    code, output = sandbox.exec(probe, ["sshpass", "-p", "lab-only-password", "ssh", "-p", str(port),
                                        "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                                        "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no",
                                        "-o", "ConnectTimeout=4", f"synthetic@{target}", "true"])
    configured = directives.get("passwordauthentication", "").lower()
    if configured == "yes":
        verdict = "confirmed" if code == 0 else "inconclusive"
    elif configured == "no":
        verdict = "not_reproduced" if code != 0 and "permission denied" in output.lower() else "inconclusive"
    else:
        verdict = "inconclusive"
    return {"test_id": "openssh.password_login", "verdict": verdict,
            "observations": {"exit_code": code, "login_succeeded": code == 0, "permission_denied": "permission denied" in output.lower()}}


def sampled_resources(containers: list) -> tuple[int, int]:
    total_cpu_millis, total_ram_mb = 0, 0
    for container in containers:
        try:
            stats = container.stats(stream=False)
            memory = stats.get("memory_stats", {}).get("usage", 0)
            current = stats.get("cpu_stats", {})
            previous = stats.get("precpu_stats", {})
            cpu_delta = current.get("cpu_usage", {}).get("total_usage", 0) - previous.get("cpu_usage", {}).get("total_usage", 0)
            sys_delta = current.get("system_cpu_usage", 0) - previous.get("system_cpu_usage", 0)
            cores = current.get("online_cpus", 1)
            total_cpu_millis += max(0, int(cpu_delta / sys_delta * cores * 1000)) if sys_delta > 0 else 0
            total_ram_mb += max(0, int(memory / 1048576))
        except Exception:
            # Missing measurement is visible as a run error at the caller.
            raise RuntimeError("Docker resource statistics unavailable")
    return total_cpu_millis, total_ram_mb


async def execute_run(store: RunStore, client, row: dict, worker_id: str, destinations: dict):
    run_id = row["id"]
    plan = row["plan"]
    services = {service["id"]: service for service in row["services"]}
    peak_cpu = peak_ram = 0
    status = "completed"
    error = ""
    cleanup_status = "complete"
    hunter_reserved = 0
    hunter_run_budget = min(131072, max(1024, int(os.environ.get("TWIN_HUNTER_RUN_TOKENS", "65536"))))
    for wave in plan["waves"]:
        sandbox = None
        wave_health = {}
        try:
            selected = [services[service_id] for service_id in wave["service_ids"]]
            rendered = {}
            for service in selected:
                upstream = None
                if service["kind"] == "nginx":
                    for path in plan["paths"]:
                        nodes = path["nodes"]
                        for left, right in zip(nodes, nodes[1:]):
                            if left == service["host_id"]:
                                target = next((s for s in selected if s["host_id"] == right and s["kind"] == "nginx"), None)
                                if target:
                                    upstream = f"dt-{str(run_id).replace('-', '')[:12]}-{hashlib.sha256(target['id'].encode()).hexdigest()[:6]}:8080"
                rendered[service["id"]] = render(service["kind"], service["version"], service["directives"],
                                                   service.get("hba_rules"), service.get("unsupported"), upstream,
                                                   hashlib.sha256(service["id"].encode()).hexdigest()[:12])
            unsupported = [s for s in selected if not rendered[s["id"]].supported]
            if unsupported:
                status = "failed"
                error = "one or more planned waves have unsupported fidelity"
                for service in unsupported:
                    await store.finding(run_id, wave["index"], _finding(service, rendered[service["id"]].image,
                        "adapter.fidelity", "unsupported", {}, rendered[service["id"]].fidelity_gaps))
                await store.wave(run_id, wave["index"], "unsupported", wave["service_ids"], wave["path_ids"],
                                 {"unsupported": [s["id"] for s in unsupported]})
                continue
            sandbox = Sandbox(client, str(run_id), worker_id, destinations, row.get("tenant_id", "default"))
            controls = sandbox.positive_controls()
            if not all(controls.values()):
                raise RuntimeError(f"designated positive controls unavailable: {[k for k,v in controls.items() if not v]}")
            await store.wave(run_id, wave["index"], "running", wave["service_ids"], wave["path_ids"], {"positive_controls": controls})
            instances = {}
            for service in selected:
                instances[service["id"]] = sandbox.launch_service(service, rendered[service["id"]])
            # Attach only pairs explicitly adjacent in a planned path.
            linked = set()
            for path in plan["paths"]:
                if path["id"] not in wave["path_ids"]:
                    continue
                for left, right in zip(path["nodes"], path["nodes"][1:]):
                    for source in selected:
                        for target in selected:
                            if source["host_id"] != left or target["host_id"] != right:
                                continue
                            pair = tuple(sorted((source["id"], target["id"])))
                            if pair in linked or pair[0] == pair[1]:
                                continue
                            linked.add(pair)
                            network = sandbox.network("link-" + hashlib.sha256("|".join(pair).encode()).hexdigest()[:6])
                            for service_id in pair:
                                network.connect(instances[service_id][0], aliases=[instances[service_id][0].name])
            for service in selected:
                sandbox.start_service(instances[service["id"]][0], rendered[service["id"]])
            for service in selected:
                container, net = instances[service["id"]]
                ready, detail = sandbox.readiness(container, service["kind"])
                wave_health[service["id"]] = {"ready": ready, "detail": detail}
                if not ready:
                    raise RuntimeError(f"twin not ready: {service['id']}")
            for service in selected:
                container, net = instances[service["id"]]
                probe = sandbox.probe_container(service["id"], net)
                other = next((instances[s["id"]][0].name for s in selected if s["id"] != service["id"]), None)
                isolation = sandbox.isolation(probe, container.name, rendered[service["id"]].port, other)
                wave_health[service["id"]]["isolation"] = isolation
                prerequisites = {"ready": True, "isolation": isolation, "positive_controls": controls}
                if not isolation["passed"]:
                    await store.finding(run_id, wave["index"], _finding(service, container.image.id,
                        "isolation.paths", "inconclusive", isolation, rendered[service["id"]].fidelity_gaps, prerequisites))
                    raise RuntimeError(f"isolation check failed: {service['id']}")
                check = behavior(sandbox, probe, service, container, rendered[service["id"]].port)
                await store.finding(run_id, wave["index"], _finding(service, container.image.id, check["test_id"],
                    check["verdict"], check["observations"], rendered[service["id"]].fidelity_gaps, prerequisites))
                if check["verdict"] in {"inconclusive", "unsupported"}:
                    raise RuntimeError(f"configuration behavior not verified: {service['id']}")
                sampled_cpu, sampled_ram = sampled_resources(list(sandbox.containers))
                peak_cpu, peak_ram = max(peak_cpu, sampled_cpu), max(peak_ram, sampled_ram)
                if sampled_cpu > wave["cpu_millis"] or sampled_ram > wave["ram_mb"]:
                    raise RuntimeError("measured resource usage exceeded the wave budget")
                sandbox.remove_container(probe)
            # A path is validated only when an end-to-end behavior check runs with all
            # dependency twins present; individual target checks do not validate it.
            for path in plan["paths"]:
                if path["id"] not in wave["path_ids"]:
                    continue
                nodes = path["nodes"]
                if len(nodes) != 2:
                    continue
                source = next((s for s in selected if s["host_id"] == nodes[0] and s["kind"] == "nginx"), None)
                target = next((s for s in selected if s["host_id"] == nodes[1] and s["kind"] == "nginx"), None)
                if not source or not target or not any(d.get("name") == "proxy_pass" for d in source.get("directives", [])):
                    continue
                source_container, source_net = instances[source["id"]]
                probe = sandbox.probe_container(path["id"], source_net)
                code, output = sandbox.exec(probe, ["curl", "-sS", "--max-time", "4", f"http://{source_container.name}:8080/"])
                marker = hashlib.sha256(target["id"].encode()).hexdigest()[:12]
                verdict = "confirmed" if code == 0 and f"synthetic twin {marker}" in output else "inconclusive"
                await store.finding(run_id, wave["index"], _finding(source, source_container.image.id,
                    "scenario.http_chain", verdict, {"path_id": path["id"], "target_marker_seen": verdict == "confirmed"},
                    rendered[source["id"]].fidelity_gaps + rendered[target["id"]].fidelity_gaps,
                    {"all_dependencies_present": True}))
                sandbox.remove_container(probe)
                if verdict != "confirmed":
                    raise RuntimeError(f"end-to-end path behavior not verified: {path['id']}")
            for service in selected:
                container, net = instances[service["id"]]
                probe = sandbox.probe_container(service["id"] + ":security", net)
                prerequisites = {"ready": True, "isolation": wave_health[service["id"]]["isolation"],
                                 "configuration_behavior_verified": True}
                code, output = sandbox.exec(probe, ["nmap", "-sT", "-Pn", "-n", "-p", str(rendered[service["id"]].port),
                                                    "--max-retries", "1", "--host-timeout", "15s", container.name])
                await store.finding(run_id, wave["index"], _finding(service, container.image.id, "nmap.port",
                    "confirmed" if code == 0 and "open" in output else "inconclusive",
                    {"exit_code": code, "output": output}, rendered[service["id"]].fidelity_gaps, prerequisites))
                if service["kind"] == "nginx":
                    code, output = sandbox.exec(probe, ["nuclei", "-t", "/run/twin/nginx-header.yaml",
                        "-u", f"http://{container.name}:{rendered[service['id']].port}", "-disable-update-check",
                        "-no-interactsh", "-rate-limit", "2", "-concurrency", "1", "-timeout", "3", "-retries", "0", "-jsonl"])
                    await store.finding(run_id, wave["index"], _finding(service, container.image.id, "nuclei.nginx_header",
                        "confirmed" if code == 0 and '"template-id":"twin-nginx-header"' in output else "inconclusive" if code or "error" in output.lower() else "not_reproduced",
                        {"exit_code": code, "output": output}, rendered[service["id"]].fidelity_gaps, prerequisites))
                if os.environ.get("TWIN_HUNTER_ENABLED", "0") == "1":
                    from ..phase3.integration import run_attached_hunt
                    hunted = run_attached_hunt(sandbox, service, selected, container, net, probe,
                                               rendered[service["id"]], hunter_run_budget - hunter_reserved)
                    hunter_reserved += hunted["reserved_tokens"]
                    await store.record_hunt(run_id, wave["index"], service["id"], hunted)
                sampled_cpu, sampled_ram = sampled_resources(list(sandbox.containers))
                peak_cpu, peak_ram = max(peak_cpu, sampled_cpu), max(peak_ram, sampled_ram)
                if sampled_cpu > wave["cpu_millis"] or sampled_ram > wave["ram_mb"]:
                    raise RuntimeError("measured resource usage exceeded the wave budget")
                sandbox.remove_container(probe)
            await store.wave(run_id, wave["index"], "completed", wave["service_ids"], wave["path_ids"], wave_health)
        except Exception as exc:
            LOG.exception("wave failed run=%s wave=%s", run_id, wave["index"])
            status = "failed"
            error = str(exc)
            await store.wave(run_id, wave["index"], "failed", wave["service_ids"], wave["path_ids"], wave_health)
            break
        finally:
            if sandbox:
                errors = sandbox.cleanup()
                if errors:
                    cleanup_status = "failed:" + ",".join(errors)
                    status = "failed"
                    error = "sandbox cleanup failed"
    await store.update_run(run_id, status, cleanup_status, error, peak_cpu, peak_ram)


async def main():
    if platform.system() != "Linux":
        raise RuntimeError("worker must run on a dedicated Linux sandbox host")
    logging.basicConfig(level=logging.INFO)
    database_url = os.environ["TWIN_EMULATION_DATABASE_URL"]
    destinations = json.loads(Path(os.environ["TWIN_EMULATION_DESTINATIONS_FILE"]).read_text(encoding="utf-8"))
    worker_id = os.environ.get("TWIN_EMULATION_WORKER_ID", platform.node())
    client = docker.from_env()
    client.ping()
    reconcile_labeled(client, worker_id)
    pool = await asyncpg.create_pool(database_url)
    store = RunStore(pool)
    await store.ensure_schema()
    await store.interrupt_stale(worker_id)
    stopping = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, stopping.set)
    try:
        while not stopping.is_set():
            row = await store.claim(worker_id)
            if row:
                await execute_run(store, client, row, worker_id, destinations)
            else:
                try:
                    await asyncio.wait_for(stopping.wait(), 2)
                except TimeoutError:
                    pass
    finally:
        await pool.close()
        client.close()


if __name__ == "__main__":
    asyncio.run(main())

