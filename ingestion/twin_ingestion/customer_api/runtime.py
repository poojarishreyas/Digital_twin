"""Disposable internet -> gateway -> customer API -> database bundle.

Modeled on public reporting of the 2022 Optus exposure: an internet-reachable
customer endpoint without authentication and with sequential identifiers. All
records are generated synthetic people; nothing here reproduces Optus systems.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import subprocess
import time
from uuid import uuid4

import docker

from ..phase3.contracts import digest

LABEL = "digital-twin.customer-api.job"
ROLES = ("internet", "gateway", "api", "database")
LINKS = (("internet", "gateway"), ("gateway", "api"), ("api", "database"))
POLICIES = {"open", "enforced", "deny_all"}
FIRST_ID = 1000001
CUSTOMERS = 40
SIGNED_IN_CUSTOMER = "1000007"   # The legitimate self-service customer.
OTHER_CUSTOMER = "1000008"       # A neighbour that customer must not read.
STAFF_LOOKUP = "1000012"         # A record internal support legitimately reads.
ENUMERATION = 20                 # Bounded attacker batch: FIRST_ID .. FIRST_ID+19.

_GIVEN = ("Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie", "Avery", "Quinn")
_FAMILY = ("Example", "Sample", "Testcase", "Fixture", "Placeholder", "Mockford", "Dummyson", "Synthwell")


def synthetic_customers(tenant: str) -> dict[str, dict]:
    """Deterministic fake identities; every value is visibly synthetic."""
    customers = {}
    for n in range(CUSTOMERS):
        customer_id = str(FIRST_ID + n)
        seed = hashlib.sha256(f"{tenant}:{customer_id}".encode()).hexdigest()
        customers[customer_id] = {
            "customer_id": customer_id,
            "full_name": f"{_GIVEN[n % len(_GIVEN)]} {_FAMILY[n % len(_FAMILY)]} (synthetic)",
            "date_of_birth": f"19{60 + int(seed[:2], 16) % 40}-{1 + int(seed[2:4], 16) % 12:02d}-{1 + int(seed[4:6], 16) % 28:02d}",
            "email": f"customer{customer_id}@{tenant}.example.invalid",
            "phone": f"+00 555 {customer_id[-4:]}",
            "address": f"{1 + int(seed[6:8], 16) % 200} Synthetic Street, Exampleville",
            "id_document": f"SYN-DL-{seed[8:16].upper()}",
        }
    return customers


class CustomerApiLab:
    """One tenant, approved images, three declared links and no published ports."""

    def __init__(self, tenant: str, images: dict, *, stage="original", policy="open"):
        if not tenant or len(tenant) > 32 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in tenant):
            raise ValueError("invalid tenant")
        if stage not in {"original", "candidate"}:
            raise ValueError("invalid environment stage")
        if policy not in POLICIES:
            raise ValueError("unsupported customer API policy")
        if set(images) != {"node_image", "database_image"}:
            raise ValueError("node and database image identities required")
        self.tenant, self.images, self.stage, self.policy = tenant, dict(images), stage, policy
        self.id = uuid4().hex
        self.client = docker.from_env(timeout=15)
        self.containers, self.networks, self.cleanup_errors = {}, [], []
        self.credentials = {name: secrets.token_hex(24) for name in ("customer", "staff", "database", "database_admin")}
        self.customers = synthetic_customers(tenant)
        self.namespace = f"cx-{self.id[:12]}"
        self.target_id = self.namespace + ":gateway"

    def __enter__(self):
        try:
            for image in self.images.values():
                if self.client.images.get(image).id != image:
                    raise ValueError("approved image identity mismatch")
            for a, b in LINKS:
                self.networks.append(self.client.networks.create(f"{self.namespace}-{a}-{b}", internal=True,
                    labels={LABEL: self.id, "digital-twin.tenant": self.tenant}))
            for role in ROLES:
                net = self.networks[0 if role == "internet" else 2 if role == "database" else 1]
                database = role == "database"
                self.containers[role] = self.client.containers.create(
                    self.images["database_image" if database else "node_image"],
                    name=f"{self.namespace}-{role}", hostname=role, network=net.name,
                    networking_config={net.name: self.client.api.create_endpoint_config(aliases=[role])},
                    environment={"POSTGRES_PASSWORD": self.credentials["database_admin"], "POSTGRES_DB": "customers"} if database else {},
                    detach=True, read_only=True, mem_limit="512m" if database else "192m",
                    nano_cpus=500_000_000 if database else 150_000_000, pids_limit=96,
                    cap_drop=["NET_ADMIN", "NET_RAW", "SYS_ADMIN"],
                    security_opt=["no-new-privileges:true"],
                    tmpfs={"/tmp": "rw,noexec,nosuid,size=16m", "/run": "rw,nosuid,size=16m",
                           "/var/lib/postgresql/data": "rw,nosuid,size=256m"},
                    labels={LABEL: self.id, "digital-twin.tenant": self.tenant,
                            "digital-twin.customer-api.role": role, "digital-twin.customer-api.stage": self.stage})
            # Declared pairwise links only; there is no flat network.
            for (a, b), net in zip(LINKS, self.networks):
                for role in (a, b):
                    container = self.containers[role]
                    container.reload()
                    if net.name not in container.attrs["NetworkSettings"]["Networks"]:
                        net.connect(container, aliases=[role])
            self.containers["database"].start()
            for _ in range(80):
                code, _ = self.exec("database", ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "customers"])
                if code == 0:
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError("database did not become ready")
            self.sql(self.seed())
            for role in ("api", "gateway", "internet"):
                self.containers[role].start()
                self.write(role, self.config(role))
                code, _ = self.exec(role, ["python", "-u", "/app/customer_app.py"], detach=True)
                if code:
                    raise RuntimeError("application startup failed")
            for role in ("api", "gateway", "internet"):
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

    def seed(self):
        def text(value):
            return "'" + value.replace("'", "''") + "'"
        rows = ",\n".join("(" + ",".join(text(c[k]) for k in ("customer_id", "full_name", "date_of_birth",
                          "email", "phone", "address", "id_document")) + ")" for c in self.customers.values())
        return f"""CREATE ROLE customer_app LOGIN PASSWORD '{self.credentials["database"]}';
            CREATE TABLE customers(customer_id text PRIMARY KEY, full_name text, date_of_birth text,
              email text, phone text, address text, id_document text);
            INSERT INTO customers VALUES {rows};
            CREATE TABLE access_audit(request_id text PRIMARY KEY, actor text, customer_id text, outcome integer);
            GRANT SELECT ON customers TO customer_app; GRANT INSERT ON access_audit TO customer_app;"""

    def config(self, role):
        base = {"tenant": self.tenant, "role": role}
        if role == "gateway":
            return {**base, "api": "api"}
        if role == "api":
            return {**base, "authorization": self.policy, "database": "database",
                    "database_password": self.credentials["database"],
                    "staff_credential": self.credentials["staff"],
                    "customer_sessions": {self.credentials["customer"]: SIGNED_IN_CUSTOMER}}
        return base  # The internet client holds no credential at all.

    def exec(self, role, argv, *, detach=False):
        if role not in self.containers:
            raise ValueError("unregistered customer API component")
        result = self.containers[role].exec_run(argv, detach=detach)
        return (0 if result.exit_code is None and detach else result.exit_code,
                (result.output or b"").decode("utf-8", "replace")[:262144])

    def write(self, role, value):
        # Fixed writer; secrets travel on stdin into tmpfs, never in argv or the image.
        result = subprocess.run(["docker", "exec", "-i", self.containers[role].id, "sh", "-c",
            "umask 077; mkdir -p /run/customer; cat > /run/customer/config.json"],
            input=json.dumps(value).encode(), capture_output=True, timeout=8)
        if result.returncode:
            raise RuntimeError("runtime tmpfs configuration write failed")

    def sql(self, query):
        # Trusted orchestrator-only SQL; no model action accepts a query.
        result = subprocess.run(["docker", "exec", "-i", self.containers["database"].id,
            "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "customers", "-At"],
            input=query, text=True, capture_output=True, timeout=15)
        if result.returncode:
            raise RuntimeError("synthetic database operation failed")
        return result.stdout.strip()

    def fetch(self, customer_ids, actor="anonymous"):
        """Executed requests through the registered gateway, each correlated end to end."""
        if actor not in {"anonymous", "customer", "staff"}:
            raise ValueError("request outside synthetic test contract")
        if not 1 <= len(customer_ids) <= ENUMERATION or any(c not in self.customers for c in customer_ids):
            raise ValueError("customer identifiers outside synthetic test contract")
        request_ids = [uuid4().hex for _ in customer_ids]
        # Anonymous and signed-in customers arrive from the internet; support staff
        # work from a trusted internal context and never pass through the attacker host.
        client = "gateway" if actor == "staff" else "internet"
        gateway_ip = self.ip("gateway", 0 if client == "internet" else 1)
        code, raw = self.exec(client, ["python", "-c",
            "import socket,json;print(json.dumps(sorted({r[4][0] for r in socket.getaddrinfo('gateway',8080,type=socket.SOCK_STREAM)})))"])
        if client == "internet" and (code or json.loads(raw) != [gateway_ip]):
            raise ValueError("gateway resolver differs from registered twin")
        payload = {"host": gateway_ip if client == "internet" else "127.0.0.1", "customer_ids": customer_ids,
                   "request_ids": request_ids, "credential": self.credentials.get(actor)}
        result = subprocess.run(["docker", "exec", "-i", self.containers[client].id,
            "python", "/app/customer_app.py", "probe"], input=json.dumps(payload),
            text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError("registered internet-to-gateway request failed")
        responses = json.loads(result.stdout.strip().splitlines()[-1])["results"]
        quoted = ",".join(f"'{r}'" for r in request_ids)  # uuid4 hex only
        audit = {row["request_id"]: row for row in json.loads(self.sql(
            "SELECT coalesce(json_agg(json_build_object('request_id',request_id,'actor',actor,"
            f"'customer_id',customer_id,'status',outcome)),'[]')::text FROM access_audit WHERE request_id IN ({quoted});"))}
        gateway = self.correlated("gateway", request_ids)
        api = self.correlated("api", request_ids)
        observations = []
        for response in responses:
            rid, cid = response["request_id"], response["customer_id"]
            returned = response["body"].get("customer")
            observations.append({
                "request_id": rid, "customer_id": cid, "actor": actor, "http_status": response["status"],
                "returned_expected_record": returned == self.customers[cid],
                "record_hash": digest(returned) if returned else None,
                "fields_returned": sorted(returned) if returned else [],
                "gateway_correlated": rid in gateway, "api_correlated": rid in api,
                "database_audit": audit.get(rid),
                "chain_verified": rid in gateway and rid in api and rid in audit})
        return {"actor": actor, "client_context": {"anonymous": "unauthenticated_internet_client",
                    "customer": "signed_in_customer_from_internet", "staff": "trusted_internal_support"}[actor],
                "path": [client if actor != "staff" else "trusted_support", "gateway", "api", "database"],
                "observations": observations, "environment_id": self.id, "tenant_id": self.tenant}

    def correlated(self, role, request_ids):
        code, raw = self.exec(role, ["python", "-c",
            "from pathlib import Path;p=Path('/run/customer/events.jsonl');"
            "print(p.read_text() if p.exists() else '')"])
        wanted, seen = set(request_ids), set()
        for line in raw.splitlines() if code == 0 else []:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("component") == role and event.get("request_id") in wanted:
                seen.add(event["request_id"])
        return seen

    def masked_sample(self, customer_id):
        """A redacted sample for reports; synthetic, yet still never printed whole."""
        c = self.customers[customer_id]
        return {"customer_id": customer_id, "full_name": c["full_name"].split()[0] + " ***",
                "date_of_birth": c["date_of_birth"][:4] + "-**-**", "email": "***@" + c["email"].split("@")[1],
                "id_document": c["id_document"][:7] + "********"}

    def network_test(self, role, destination, port):
        import ipaddress
        ipaddress.ip_address(destination)
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
            "internet_gateway_allowed": self.network_test("internet", self.ip("gateway", 0), 8080),
            "internet_api_blocked": not self.network_test("internet", self.ip("api", 1), 8080),
            "internet_database_blocked": not self.network_test("internet", self.ip("database", 2), 5432),
            "gateway_database_blocked": not self.network_test("gateway", self.ip("database", 2), 5432),
        }
        return {"scope": "docker_internal_network_segmentation", "checks": checks,
                "passed": all(checks.values()), "host_lan_internet_firewall_certified": False}

    def credential_scope(self):
        code, raw = self.exec("internet", ["cat", "/run/customer/config.json"])
        if code:
            raise RuntimeError("internet client configuration cannot be inspected")
        environment = json.dumps(self.containers["internet"].attrs.get("Config", {}).get("Env", []))
        return {"internet_client_holds_no_credentials": not any(
                    value in raw or value in environment for value in self.credentials.values()),
                "gateway_holds_no_credentials": not any(
                    value in json.dumps(self.config("gateway")) for value in self.credentials.values()),
                "application_and_database_admin_passwords_distinct":
                    self.credentials["database"] != self.credentials["database_admin"]}

    def identity(self):
        return {"id": self.id, "stage": self.stage, "tenant_id": self.tenant, "policy": self.policy,
                "images": {r: c.image.id for r, c in self.containers.items()},
                "network_rules": [list(link) for link in LINKS], "published_ports": False,
                "endpoint": "GET /v1/customers/{customer_id}", "identifier_scheme": "sequential 7-digit",
                "synthetic_customers": CUSTOMERS,
                "configuration_hash": digest({"images": self.images, "policy": self.policy}),
                "scope": "synthetic application behavior; Docker internal network isolation"}

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
            raise RuntimeError("customer API environment cleanup failed")
