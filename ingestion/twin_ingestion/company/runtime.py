"""Disposable application bundles. Docker Desktop behavior scope is explicit."""
from __future__ import annotations

import json
import secrets
import subprocess
import time
from pathlib import Path
from uuid import uuid4

import docker

from ..phase3.contracts import digest
from .contracts import Artifact

LABEL = "digital-twin.company.job"
ROLES = ("employee", "gateway", "api", "database")
JOB_CPU_MILLIS = 1900  # Original plus one complete candidate, 950m each.
JOB_RAM_MB = 2176


class CompanyLab:
    """One tenant, immutable images, three declared links and no published ports."""

    def __init__(self, tenant: str, artifact: Artifact, catalog: dict, *, stage="original", policy=None):
        if not tenant or len(tenant) > 32 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in tenant):
            raise ValueError("invalid tenant")
        if stage not in {"source", "original", "candidate", "control"}:
            raise ValueError("invalid environment stage")
        if {k: catalog.get(k) for k in ("node_image", "database_image")} != {
                "node_image": artifact.node_image, "database_image": artifact.database_image}:
            raise ValueError("artifact images are not approved by this worker")
        self.tenant, self.artifact, self.stage = tenant, artifact, stage
        self.policy = policy or artifact.authorization
        if self.policy not in {"authentication_only", "enforced", "deny_all"}:
            raise ValueError("unsupported candidate policy")
        self.id = uuid4().hex
        self.client = docker.from_env(timeout=15)
        self.containers, self.networks = {}, []
        self.cleanup_errors = []
        self.credentials = {name: secrets.token_hex(24) for name in ("employee", "admin", "database", "database_admin")}
        self.source_agents = artifact.source_agents
        self.namespace = f"co-{self.id[:12]}"
        self.started = time.monotonic()
        self.target_id = self.namespace + ":gateway"

    def __enter__(self):
        try:
            for image in (self.artifact.node_image, self.artifact.database_image):
                if self.client.images.get(image).id != image:
                    raise ValueError("approved image identity mismatch")
            for a, b in self.artifact.links:
                net = self.client.networks.create(f"{self.namespace}-{a}-{b}", internal=True,
                    labels={LABEL: self.id, "digital-twin.tenant": self.tenant})
                self.networks.append(net)
            for role in ROLES:
                net = self.networks[0 if role == "employee" else 2 if role == "database" else 1]
                database = role == "database"
                container = self.client.containers.create(
                    self.artifact.database_image if database else self.artifact.node_image,
                    name=f"{self.namespace}-{role}", hostname=role, network=net.name,
                    networking_config={net.name: self.client.api.create_endpoint_config(aliases=[role])},
                    environment={"POSTGRES_PASSWORD": self.credentials["database_admin"], "POSTGRES_DB": "company"} if database else {},
                    detach=True, read_only=True, mem_limit="512m" if database else "192m",
                    nano_cpus=500_000_000 if database else 150_000_000, pids_limit=96,
                    cap_drop=["NET_ADMIN", "NET_RAW", "SYS_ADMIN"],
                    security_opt=["no-new-privileges:true"],
                    tmpfs={"/tmp": "rw,noexec,nosuid,size=16m", "/run": "rw,nosuid,size=16m",
                           "/var/lib/postgresql/data": "rw,nosuid,size=256m"},
                    labels={LABEL: self.id, "digital-twin.tenant": self.tenant,
                            "digital-twin.company.role": role, "digital-twin.company.stage": self.stage})
                self.containers[role] = container
            # Primary aliases and declared pairwise links; no flat company network.
            for (a, b), net in zip(self.artifact.links, self.networks):
                for role in (a, b):
                    container = self.containers[role]
                    container.reload()
                    if net.name not in container.attrs["NetworkSettings"]["Networks"]:
                        net.connect(container, aliases=[role])
            database = self.containers["database"]
            database.start()
            for _ in range(80):
                code, _ = self.exec("database", ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "company"])
                if code == 0:
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError("database did not become ready")
            password = self.credentials["database"]
            seed = f"""CREATE ROLE company_app LOGIN PASSWORD '{password}';
                CREATE TABLE records(id text PRIMARY KEY, classification text NOT NULL, body text NOT NULL);
                INSERT INTO records VALUES ('ordinary','ordinary','synthetic-{self.tenant}-ordinary-record'),
                  ('restricted','restricted','synthetic-{self.tenant}-restricted-record');
                CREATE TABLE access_audit(request_id text PRIMARY KEY,actor text,record_id text,outcome integer);
                GRANT SELECT ON records TO company_app; GRANT INSERT ON access_audit TO company_app;"""
            self.sql(seed)
            for role in ("api", "gateway", "employee"):
                container = self.containers[role]
                container.start()
                self.write(role, "config.json", self.config(role))
                code, _ = self.exec(role, ["python", "-u", "/app/company_app.py"], detach=True)
                if code:
                    raise RuntimeError("application startup failed")
            for role in ("api", "gateway", "employee"):
                for _ in range(60):
                    code, raw = self.exec(role, ["python", "-c",
                        "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=2).read().decode())"])
                    if code == 0 and json.loads(raw).get("ready"):
                        break
                    time.sleep(0.2)
                else:
                    raise RuntimeError("application readiness failed: " + role)
            return self
        except BaseException:
            self.close()
            raise

    def config(self, role):
        base = {"tenant": self.tenant, "role": role}
        if role == "employee":
            return {**base, "gateway": "gateway", "employee_credential": self.credentials["employee"],
                    "discovery_traffic": self.stage == "source"}
        if role == "gateway":
            return {**base, "api": "api"}
        if role == "api":
            return {**base, "authorization": self.policy, "database": "database",
                    "database_password": self.credentials["database"],
                    "employee_credential": self.credentials["employee"], "admin_credential": self.credentials["admin"]}
        return base

    def exec(self, role, argv, *, detach=False):
        if role not in self.containers:
            raise ValueError("unregistered company component")
        result = self.containers[role].exec_run(argv, detach=detach)
        return (0 if result.exit_code is None and detach else result.exit_code,
                (result.output or b"").decode("utf-8", "replace")[:65536])

    def write(self, role, name, value):
        if name not in {"config.json", "workload.json", "agent.yaml", "ca.crt", "agent.crt", "agent.key"}:
            raise ValueError("unregistered runtime file")
        content = json.dumps(value).encode() if isinstance(value, dict) else value.encode()
        # Docker archive-copy refuses read-only rootfs even for tmpfs targets.
        # This fixed host-orchestrator writer receives secrets on stdin only;
        # neither the model nor a caller can supply a command or filename.
        result = subprocess.run(["docker", "exec", "-i", self.containers[role].id,
            "sh", "-c", 'umask 077; mkdir -p /run/company; cat > "/run/company/$1"', "sh", name],
            input=content, capture_output=True, timeout=8)
        if result.returncode:
            raise RuntimeError("runtime tmpfs configuration write failed")

    def sql(self, query):
        # Trusted verifier-only SQL; no model action accepts a query.
        result = subprocess.run(["docker", "exec", "-i", self.containers["database"].id,
            "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "company", "-At"],
            input=query, text=True, capture_output=True, timeout=15)
        if result.returncode:
            raise RuntimeError("synthetic database operation failed")
        return result.stdout.strip()

    def request(self, record="ordinary", actor="employee", *, credential=None):
        if record not in {"ordinary", "restricted"} or actor not in {"employee", "admin"}:
            raise ValueError("request outside synthetic test contract")
        nonce = uuid4().hex
        expected_ip = self.ip("gateway", 0)
        code, raw = self.exec("employee", ["python", "-c",
            "import socket,json;print(json.dumps(sorted({r[4][0] for r in socket.getaddrinfo('gateway',8080,type=socket.SOCK_STREAM)})))"])
        if code or json.loads(raw) != [expected_ip]:
            raise ValueError("company gateway resolver differs from registered twin")
        payload = {"host": expected_ip, "record": record, "actor": actor,
                   "credential": credential or self.credentials[actor], "request_id": nonce}
        client_role = "employee" if actor == "employee" else "gateway"
        result = subprocess.run(["docker", "exec", "-i", self.containers[client_role].id,
            "python", "/app/company_app.py", "probe"], input=json.dumps(payload),
            text=True, capture_output=True, timeout=8)
        if result.returncode:
            raise RuntimeError("registered employee-to-gateway request failed")
        response = json.loads(result.stdout)
        audit = self.sql("SELECT json_build_object('actor',actor,'record',record_id,'status',outcome)::text "
                         f"FROM access_audit WHERE request_id='{nonce}';")
        gateway = any(self._event(line, nonce, "gateway") for line in self.events("gateway"))
        api = any(self._event(line, nonce, "api") for line in self.events("api"))
        expected = f"synthetic-{self.tenant}-{record}-record"
        returned = response.get("body", {}).get("record", {}).get("body")
        verified = bool(audit and gateway and api)
        return {"request_id": nonce, "actor": actor, "record": record, "http_status": response["status"],
                "returned_expected_record": returned == expected,
                "record_hash": digest(returned) if returned else None,
                "path": ["employee" if actor == "employee" else "trusted_admin_probe", "gateway", "api", "database"],
                "client_context": "compromised_employee" if actor == "employee" else "trusted_gateway_workflow_probe",
                "gateway_correlated": gateway, "api_correlated": api,
                "database_audit": json.loads(audit) if audit else None,
                "chain_verified": verified, "environment_id": self.id, "tenant_id": self.tenant}

    @staticmethod
    def _event(line, nonce, component):
        try:
            event = json.loads(line)
            return event.get("request_id") == nonce and event.get("component") == component
        except ValueError:
            return False

    def events(self, role):
        code, raw = self.exec(role, ["python", "-c",
            "from pathlib import Path;p=Path('/run/company/events.jsonl');"
            "print(''.join(p.read_text().splitlines(keepends=True)[-150:]) if p.exists() else '')"])
        return raw.splitlines() if code == 0 else []

    def network_test(self, role, destination, port):
        import ipaddress
        ipaddress.ip_address(destination)
        if not 1 <= port <= 65535:
            raise ValueError("invalid isolation destination")
        code, raw = self.exec(role, ["python", "-c",
            "import socket,sys; s=socket.socket();s.settimeout(1);"
            "r=s.connect_ex((sys.argv[1],int(sys.argv[2])));s.close();print(r)", destination, str(port)])
        if code:
            raise RuntimeError("network control failed")
        return int(raw.strip()) == 0

    def ip(self, role, network_index):
        self.containers[role].reload()
        return self.containers[role].attrs["NetworkSettings"]["Networks"][self.networks[network_index].name]["IPAddress"]

    def isolation(self):
        checks = {
            "employee_gateway_allowed": self.network_test("employee", self.ip("gateway", 0), 8080),
            "employee_api_blocked": not self.network_test("employee", self.ip("api", 1), 8080),
            "employee_database_blocked": not self.network_test("employee", self.ip("database", 2), 5432),
            "gateway_database_blocked": not self.network_test("gateway", self.ip("database", 2), 5432),
        }
        return {"scope": "docker_internal_network_segmentation", "checks": checks,
                "passed": all(checks.values()), "host_lan_internet_firewall_certified": False}

    def identity(self):
        return {"id": self.id, "stage": self.stage, "tenant_id": self.tenant,
                "artifact_id": self.artifact.artifact_id, "policy": self.policy,
                "images": {r: c.image.id for r, c in self.containers.items()},
                "network_rules": self.artifact.links, "published_ports": False,
                "configuration_hash": digest({"artifact": self.artifact.artifact_id, "policy": self.policy}),
                "scope": "synthetic application behavior; Docker internal network isolation"}

    def credential_scope(self):
        code, raw = self.exec("employee", ["cat", "/run/company/config.json"])
        if code:
            raise RuntimeError("employee credential scope cannot be inspected")
        cfg = json.loads(raw)
        prohibited = (self.credentials["admin"], self.credentials["database"], self.credentials["database_admin"])
        environment = json.dumps(self.containers["employee"].attrs.get("Config", {}).get("Env", []))
        return {"employee_only_credential": cfg.get("employee_credential") == self.credentials["employee"]
                and not any(value in raw or value in environment for value in prohibited),
                "gateway_has_no_static_privileged_credentials": not any(
                    value in json.dumps(self.config("gateway")) for value in self.credentials.values()),
                "application_and_database_admin_passwords_distinct": self.credentials["database"] != self.credentials["database_admin"]}

    def close(self):
        for container in reversed(list(self.containers.values())):
            try:
                container.remove(force=True, v=True)
            except Exception:
                self.cleanup_errors.append("container cleanup failed")
        for network in reversed(self.networks):
            try:
                network.remove()
            except Exception:
                self.cleanup_errors.append("network cleanup failed")
        self.containers.clear()
        self.networks.clear()
        self.client.close()

    def __exit__(self, *args):
        self.close()
        if self.cleanup_errors:
            raise RuntimeError("company environment cleanup failed")
