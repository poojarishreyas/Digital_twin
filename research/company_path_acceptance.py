"""Real Docker/native-agent/two-tenant company path acceptance; synthetic data only."""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
import docker

from twin_ingestion.company.contracts import Artifact
from twin_ingestion.company.runtime import CompanyLab, ROLES
from twin_ingestion.company.verification import CompanyExecutor, security, verify_patch
from twin_ingestion.phase3.contracts import CompanyProbe
from twin_ingestion.phase3.tools import Blocked

ROOT = Path(__file__).resolve().parents[1]


def certificates(agents):
    now = datetime.now(timezone.utc)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Disposable company acceptance CA")])
    ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
        .sign(key, hashes.SHA256()))
    def issue(identifier, server=False):
        private = ec.generate_private_key(ec.SECP256R1())
        builder = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, identifier)]))
            .issuer_name(name).public_key(private.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH]), False))
        if server:
            builder = builder.add_extension(x509.SubjectAlternativeName([
                x509.DNSName("ingestion.local"), x509.DNSName("localhost"), x509.DNSName("ingestion")]), False)
        return {"cert": builder.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode(),
                "key": private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()).decode()}
    return ca.public_bytes(serialization.Encoding.PEM).decode(), issue("ingestion.local", True), {agent: issue(agent) for agent in agents}


def cleanup_report(path, *, control_plane=True):
    """Remove only the exact synthetic environments recorded by this runner."""
    report = json.loads(path.read_text())
    project = report["project"]
    if not re.fullmatch(r"company-path-[a-f0-9]{10}", project):
        raise ValueError("invalid acceptance project")
    compose_file = (ROOT / ".tools" / project / "compose.json").resolve()
    if not compose_file.is_relative_to((ROOT / ".tools").resolve()) or not compose_file.is_file():
        raise ValueError("acceptance Compose file unavailable")
    client = docker.from_env(timeout=15)
    try:
        controls = client.containers.list(all=True, filters={"label": "com.docker.compose.project=" + project})
        for source in report.get("sources", []):
            job, tenant = source["id"], source["tenant_id"]
            if not re.fullmatch(r"[a-f0-9]{32}", job) or tenant not in {"acme", "globex"}:
                raise ValueError("invalid source cleanup identity")
            labels = ["digital-twin.company.job=" + job, "digital-twin.tenant=" + tenant]
            containers = client.containers.list(all=True, filters={"label": labels})
            if any(c.labels.get("digital-twin.company.stage") != "source" for c in containers):
                raise ValueError("refusing non-source resources")
            networks = client.networks.list(filters={"label": labels})
            for network in networks:
                for control in controls:
                    with contextlib.suppress(docker.errors.APIError):
                        network.disconnect(control, force=True)
            for container in containers:
                container.remove(force=True, v=True)
            for network in networks:
                network.remove()
        if control_plane:
            subprocess.run(["docker", "compose", "-p", project, "-f", str(compose_file), "down", "-v"], check=True)
    finally:
        client.close()
    report["cleanup"] = "complete" if control_plane else "sources_released_control_plane_retained"
    report["cleaned_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"project": project, "cleanup": report["cleanup"]}))


def company_boundary_controls(deployments, catalog):
    """Independent deterministic controls, including real simultaneous tenants."""
    checks, repairs = {}, {}
    with CompanyLab("acme", deployments["acme"], catalog, stage="control") as a, CompanyLab("globex", deployments["globex"], catalog, stage="control") as b:
        assert a.isolation()["passed"] and b.isolation()["passed"]
        assert all(a.credential_scope().values()) and all(b.credential_scope().values())
        assert not a.network_test("employee", b.ip("gateway", 0), 8080)
        assert not b.network_test("employee", a.ip("gateway", 0), 8080)
        assert a.request("restricted", credential=b.credentials["employee"])["http_status"] == 401
        executor = CompanyExecutor(a, catalog)
        try:
            executor.execute(CompanyProbe(name="company_probe", target_id=b.target_id, port=8080, operation="restricted"))
            raise AssertionError("foreign tool target accepted")
        except Blocked:
            pass
        assert not executor.evidence
        checks["cross_tenant_network_credentials_and_tools_denied"] = True
        checks["employee_client_has_no_privileged_credentials"] = True
        for name, policy in (("ineffective", "authentication_only"), ("breaking", "deny_all")):
            control = verify_patch(a, catalog, policy)
            repairs[name] = control
            assert control["label"] == "rejected"
        assert repairs["ineffective"]["security_retest"]["verdict"] == "confirmed"
        assert repairs["ineffective"]["candidate_workflows"]["passed"]
        assert repairs["breaking"]["security_retest"]["verdict"] == "not_reproduced"
        assert not repairs["breaking"]["candidate_workflows"]["passed"]
        checks["ineffective_and_business_breaking_repairs_rejected"] = True
    return checks, repairs


def retained_run(args):
    """Run a new model condition without rebuilding an unchanged source deployment."""
    baseline = json.loads(args.reuse.read_text())
    project = baseline["project"]
    sources_verified = all(baseline.get("checks", {}).get(t + suffix) for t in ("acme", "globex")
        for suffix in ("_native_discovery_admitted", "_employee_only_credential_boundary"))
    if (baseline.get("superseded_for_milestone_reason") or not re.fullmatch(r"company-path-[a-f0-9]{10}", project)
            or not (baseline["status"] == "passed" or sources_verified)):
        raise ValueError("reuse requires a retained project with verified sources and credential boundaries")
    work = ROOT / ".tools" / project
    composition = json.loads((work / "compose.json").read_text())
    tokens = json.loads((work / "access.json").read_text())["tokens"]
    catalog = json.loads((work / "catalog.json").read_text())
    output = args.output or ROOT / "research/results" / (project + "-live-" + uuid4().hex[:8] + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "project": project,
        "status": "running", "model_condition": "scripted_boundary_smoke_not_ai" if args.scripted else "live_gemini",
        "sources": baseline["sources"], "image_catalog": catalog, "runs": {}, "checks": {},
        "boundary_controls_report": str(args.reuse),
        "boundary_controls_reused": {key: True for key in (
            "cross_tenant_network_credentials_and_tools_denied", "ineffective_and_business_breaking_repairs_rejected")
            if baseline.get("checks", {}).get(key) is True},
        "scope": "new live hunts; unchanged source deployment and separately retained deterministic boundary controls"}
    def save():
        output.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    def request(tenant, path, method="GET", body=None):
        req = urllib.request.Request("http://127.0.0.1:8090" + path, method=method,
            headers={"Authorization": "Bearer " + tokens[tenant], "Content-Type": "application/json"},
            data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)
    client = docker.from_env(timeout=15)
    try:
        # The rapid heartbeat was needed to test repeated discovery. Retained
        # sources use a normal cadence so a review session does not flood history.
        selected_tenants = args.tenants.split(",") if args.tenants else ["acme", "globex"]
        if not selected_tenants or not set(selected_tenants) <= {"acme", "globex"}:
            raise ValueError("only acme and globex acceptance tenants are supported")
        for source in baseline["sources"]:
            if source["tenant_id"] not in selected_tenants:
                continue
            for role in ROLES:
                container = client.containers.get(f"co-{source['id'][:12]}-{role}")
                if container.labels.get("digital-twin.company.job") != source["id"] or container.labels.get("digital-twin.tenant") != source["tenant_id"]:
                    raise ValueError("source identity changed")
                code, raw = container.exec_run(["cat", "/run/company/agent.yaml"])
                if code:
                    raise RuntimeError("source agent configuration unavailable")
                cfg = json.loads(raw)
                cfg["poll_interval"], cfg["full_snapshot_interval"] = "30s", "60s"
                result = subprocess.run(["docker", "exec", "-i", container.id, "sh", "-c",
                    "umask 077;cat > /run/company/agent.yaml"], input=json.dumps(cfg), text=True, capture_output=True, timeout=8)
                if result.returncode:
                    raise RuntimeError("source agent cadence update failed")
                container.exec_run(["sh", "-c", 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = twin-agent ] && kill "${p##*/}"; done; true'])
                time.sleep(0.3)
                container.exec_run(["sh", "-c", "exec /usr/local/bin/twin-agent -config /run/company/agent.yaml >> /run/company/agent.log 2>&1"], detach=True)
        for tenant in selected_tenants:
            artifact = Artifact.model_validate_json((work / (tenant + "-deployment.json")).read_text())
            status, inventory = request(tenant, "/api/inventory")
            own = {row["agent_id"]: row for row in inventory}
            assert status == 200 and all(own[a]["last_sequence"] >= 3 and not own[a]["stale"] for a in artifact.source_agents.values())
            status, queued = request(tenant, "/api/company/runs", "POST", {"artifact_id": artifact.artifact_id})
            assert status == 202, queued
            report["runs"][tenant] = {"run_id": queued["run_id"]}
            report["checks"][tenant + "_fresh_native_source_admitted"] = True
            print(tenant, "queued for new model condition", flush=True)
        env = {**os.environ, "PYTHONPATH": str(ROOT / "ingestion"),
            "DATABASE_URL": composition["services"]["ingestion"]["environment"]["DATABASE_URL"].replace("@postgres:5432/", "@127.0.0.1:15432/"),
            "NEO4J_URI": "bolt://127.0.0.1:17687",
            "NEO4J_PASSWORD": composition["services"]["ingestion"]["environment"]["NEO4J_PASSWORD"]}
        worker = [sys.executable, "-m", "twin_ingestion.company.worker", "--catalog", str(work / "catalog.json"),
            "--max-jobs", str(len(selected_tenants)), "--traces", str(output.parent / (output.stem + "-traces"))]
        if args.scripted:
            worker.append("--scripted")
        save()
        with (work / (output.stem + ".log")).open("w", encoding="utf-8") as log:
            completed = subprocess.run(worker, cwd=ROOT, env=env, stdout=log, stderr=log)
        assert completed.returncode == 0, "company worker exited unsuccessfully"
        for tenant in selected_tenants:
            run_id = report["runs"][tenant]["run_id"]
            status, detail = request(tenant, "/api/company/runs/" + run_id)
            report["runs"][tenant] = detail
            save()
            assert status == 200 and detail["status"] == "completed", {"tenant": tenant, "status": detail["status"], "error": detail.get("error")}
            other = "globex" if tenant == "acme" else "acme"
            assert request(other, "/api/company/runs/" + run_id)[0] == 404
            assert other not in json.dumps(detail["result"])
            report["checks"][tenant + "_attack_fix_business_retest"] = True
            report["checks"][tenant + "_foreign_run_and_trace_isolation"] = True
            if not args.scripted:
                usages = [e["payload"].get("usage", {}) for e in detail["result"]["hunter"]["trace"] if e["kind"] == "hypothesis"]
                assert usages and all("gemini-3.8-flash" in u.get("response_model", "").lower() for u in usages)
                report["checks"][tenant + "_live_expected_gemini"] = True
        if len(report["boundary_controls_reused"]) != 2:
            deployments = {t: Artifact.model_validate_json((work / (t + "-deployment.json")).read_text()) for t in ("acme", "globex")}
            print("Checking remaining two-company boundary and repair controls", flush=True)
            boundary_checks, repairs = company_boundary_controls(deployments, catalog)
            report["checks"].update(boundary_checks)
            report["repair_controls"] = repairs
            report["boundary_controls_executed_in_this_run"] = True
        report["status"] = "passed"
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = str(exc).replace(os.environ.get("TWIN_MODEL_API_KEY", "unused-key"), "<redacted>")[:1000]
        raise
    finally:
        client.close()
        report["cleanup"] = "source_and_control_plane_retained_for_review"
        report["dashboard"] = "http://localhost:3001/#company"
        report["local_access_file"] = str(work / "access.json")
        save()
        print(json.dumps({"status": report["status"], "output": str(output), "checks": report["checks"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--keep", action="store_true", help="Keep loopback control plane and source lab for dashboard review")
    parser.add_argument("--scripted", action="store_true", help="Non-AI boundary smoke; live Gemini is the default")
    parser.add_argument("--no-build", action="store_true", help="Use already built company images and API")
    parser.add_argument("--agent-binary", type=Path, help="Use a Linux/amd64 agent compiled from this checkout instead of the Go image build stage")
    parser.add_argument("--cleanup", type=Path, help="Remove a retained acceptance project's exact recorded resources")
    parser.add_argument("--release-sources", type=Path, help="Remove recorded synthetic sources while retaining the dashboard and history")
    parser.add_argument("--reuse", type=Path, help="Queue fresh hunts on an unchanged passed retained deployment")
    parser.add_argument("--tenants", help="For a retained deployment, retry only these acceptance tenants (acme,globex)")
    args = parser.parse_args()
    if args.cleanup:
        return cleanup_report(args.cleanup)
    if args.release_sources:
        return cleanup_report(args.release_sources, control_plane=False)
    if not args.scripted and not os.environ.get("TWIN_MODEL_API_KEY"):
        raise SystemExit("Set TWIN_MODEL_API_KEY for the real Gemini run, or explicitly select --scripted for a non-AI smoke")
    if args.reuse:
        return retained_run(args)
    identifier = "company-path-" + uuid4().hex[:10]
    work = ROOT / ".tools" / identifier
    work.mkdir(parents=True)
    output = args.output or ROOT / "research/results" / (identifier + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    tenant_ids = ("acme", "globex")
    tokens = {tenant: secrets.token_hex(32) for tenant in tenant_ids}
    platform_token = secrets.token_hex(32)
    agents = {tenant: {role: f"{identifier}-{tenant}-{role}" for role in ROLES} for tenant in tenant_ids}
    ca, server, certs = certificates([agent for values in agents.values() for agent in values.values()])
    (work / "ca.crt").write_text(ca)
    (work / "server.crt").write_text(server["cert"])
    (work / "server.key").write_text(server["key"])
    auth = {"version": 2, "tenants": [{"id": tenant, "name": tenant.title() + " synthetic company"} for tenant in tenant_ids],
        "principals": [{"id": "operator-" + tenant, "token_sha256": hashlib.sha256(tokens[tenant].encode()).hexdigest(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            "memberships": [{"tenant": tenant, "role": "admin"}]} for tenant in tenant_ids],
        "agents": [{"id": agent, "tenant": tenant} for tenant, values in agents.items() for agent in values.values()]}
    auth["principals"].append({"id": "scenario-platform-operator", "platform_admin": True, "memberships": [],
        "token_sha256": hashlib.sha256(platform_token.encode()).hexdigest(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})
    (work / "auth.json").write_text(json.dumps(auth))
    (work / "access.json").write_text(json.dumps({"url": "http://localhost:3001/#company", "tokens": tokens,
                                                "platform_token": platform_token}, indent=2))
    db_password, graph_password = secrets.token_hex(24), secrets.token_hex(24)
    volumes = [{"type": "bind", "source": str(work / source), "target": target, "read_only": True}
        for source, target in (("ca.crt", "/certs/ca.crt"), ("server.crt", "/certs/server.crt"),
                               ("server.key", "/certs/server.key"), ("auth.json", "/run/auth/auth.json"))]
    volumes.append({"type": "bind", "source": str(ROOT / "schema"), "target": "/app/schema", "read_only": True})
    composition = {"services": {
        "postgres": {"image": "postgres:17-alpine", "environment": {"POSTGRES_PASSWORD": db_password,
            "POSTGRES_DB": "digital_twin", "POSTGRES_USER": "twin"}, "ports": ["127.0.0.1:15432:5432"],
            "volumes": ["pgdata:/var/lib/postgresql/data", {"type": "bind", "source": str(ROOT / "deploy/postgres/init.sql"),
                "target": "/docker-entrypoint-initdb.d/001-init.sql", "read_only": True}],
            "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U twin -d digital_twin"], "interval": "2s", "retries": 45}},
        "neo4j": {"image": "neo4j:5.26-community", "environment": {"NEO4J_AUTH": "neo4j/" + graph_password,
            "NEO4J_server_memory_heap_initial__size": "128m", "NEO4J_server_memory_heap_max__size": "256m",
            "NEO4J_server_memory_pagecache_size": "128m"}, "ports": ["127.0.0.1:17687:7687"], "volumes": ["graphdata:/data"],
            "healthcheck": {"test": ["CMD-SHELL", "wget -qO- http://localhost:7474 >/dev/null || exit 1"], "interval": "3s", "retries": 60}},
        "ingestion": {"image": "twin-company-api:1.0.0", "build": {"context": str(ROOT / "ingestion")},
            "environment": {"DATABASE_URL": f"postgresql://twin:{db_password}@postgres:5432/digital_twin",
                "NEO4J_URI": "bolt://neo4j:7687", "NEO4J_PASSWORD": graph_password, "TWIN_AUTH_MODE": "tokens",
                "TWIN_AUTH_FILE": "/run/auth/auth.json", "TWIN_COOKIE_SECURE": "false",
                "TWIN_ALLOWED_ORIGINS": "http://localhost:3001,http://127.0.0.1:3001",
                "TWIN_SCHEMA_PATH": "/app/schema/telemetry-v1.schema.json"},
            "volumes": volumes, "ports": ["127.0.0.1:8090:8080", "127.0.0.1:18443:8443"],
            "depends_on": {"postgres": {"condition": "service_healthy"}, "neo4j": {"condition": "service_healthy"}},
            "healthcheck": {"test": ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:8080/readyz')"], "interval": "3s", "retries": 50}},
        "ui": {"image": "nginx:1.27-alpine", "ports": ["127.0.0.1:3001:80"], "depends_on": ["ingestion"],
            "volumes": [{"type": "bind", "source": str(ROOT / "ui/dist"), "target": "/usr/share/nginx/html", "read_only": True},
                        {"type": "bind", "source": str(ROOT / "ui/nginx.conf"), "target": "/etc/nginx/conf.d/default.conf", "read_only": True}]}},
        "volumes": {"pgdata": {}, "graphdata": {}}}
    compose_file = work / "compose.json"
    compose_file.write_text(json.dumps(composition))
    compose = ["docker", "compose", "-p", identifier, "-f", str(compose_file)]
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "project": identifier,
              "model_condition": "scripted_boundary_smoke_not_ai" if args.scripted else "live_gemini",
              "status": "running", "checks": {}, "runs": {}, "sources": [],
              "scope": "synthetic company; Docker Desktop behavior and segmentation"}
    checks = report["checks"]
    def save():
        output.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    def command(argv, *, cwd=ROOT, env=None):
        with (work / "commands.log").open("a", encoding="utf-8") as log:
            result = subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=log)
        if result.returncode:
            raise RuntimeError("command failed; inspect local command log")
    def request(tenant, path, method="GET", body=None):
        headers = {"Authorization": "Bearer " + tokens[tenant], "Content-Type": "application/json"}
        req = urllib.request.Request("http://127.0.0.1:8090" + path, headers=headers, method=method,
            data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)
    sources, telemetry_networks = [], []
    client = docker.from_env(timeout=15)
    control = None
    try:
        if not args.no_build:
            print("Building application images and API", flush=True)
            dockerfile, build_options = "emulation/company/Dockerfile", []
            if args.agent_binary:
                binary = args.agent_binary.resolve()
                if binary.read_bytes()[:4] != b"\x7fELF":
                    raise ValueError("agent-binary must be a Linux executable")
                context = work / "agent-bin"
                context.mkdir()
                shutil.copyfile(binary, context / "twin-agent")
                dockerfile = "emulation/company/Dockerfile.prebuilt"
                build_options = ["--build-context", "agent_binary=" + str(context)]
                report["agent_binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
            command(["docker", "build", *build_options, "--target", "node", "-f", dockerfile, "-t", "twin-company-node:1.0.0", "."])
            command(["docker", "build", *build_options, "--target", "database", "-f", dockerfile, "-t", "twin-company-database:1.0.0", "."])
            command([*compose, "build", "ingestion"])
        if not (ROOT / "ui/dist/index.html").exists():
            command(["npm.cmd" if os.name == "nt" else "npm", "run", "build"], cwd=ROOT / "ui")
        catalog = {"node_image": client.images.get("twin-company-node:1.0.0").id,
                   "database_image": client.images.get("twin-company-database:1.0.0").id}
        (work / "catalog.json").write_text(json.dumps(catalog))
        report["image_catalog"] = catalog
        command([*compose, "up", "-d", "--wait", "--wait-timeout", "200"])
        control_id = subprocess.check_output([*compose, "ps", "-q", "ingestion"], text=True).strip()
        control = client.containers.get(control_id)
        deployments = {}
        for tenant in tenant_ids:
            artifact = Artifact(**catalog, source_agents=agents[tenant])
            deployments[tenant] = artifact
            (work / (tenant + "-deployment.json")).write_text(artifact.model_dump_json(indent=2))
            lab = CompanyLab(tenant, artifact, catalog, stage="source")
            lab.__enter__()
            sources.append(lab)
            report["sources"].append(lab.identity())
            assert all(lab.credential_scope().values())
            checks[tenant + "_employee_only_credential_boundary"] = True
            assert lab.isolation()["passed"]
            checks[tenant + "_source_network_rules_verified"] = True
            save()
            for role in ROLES:
                net = client.networks.create(f"{lab.namespace}-telemetry-{role}", internal=True,
                    labels={"digital-twin.company.job": lab.id, "digital-twin.tenant": tenant})
                lab.networks.append(net)
                net.connect(control, aliases=["ingestion.local"])
                telemetry_networks.append(net)
                net.connect(lab.containers[role])
                agent_id = agents[tenant][role]
                for name, data in (("ca.crt", ca), ("agent.crt", certs[agent_id]["cert"]), ("agent.key", certs[agent_id]["key"])):
                    lab.write(role, name, data)
                lab.write(role, "workload.json", {"name": "company-" + role, "version": "company-records/1.0.0",
                    "image_id": catalog["database_image" if role == "database" else "node_image"],
                    "port": 5432 if role == "database" else 8080,
                    "authorization": artifact.authorization if role == "api" else ""})
                lab.write(role, "agent.yaml", json.dumps({"server_address": "ingestion.local:8443",
                    "state_dir": "/run/company/agent-state", "poll_interval": "15s", "full_snapshot_interval": "60s",
                    "workload_file": "/run/company/workload.json", "tls": {"ca": "/run/company/ca.crt",
                        "certificate": "/run/company/agent.crt", "key": "/run/company/agent.key", "server_name": "ingestion.local"}}))
                lab.exec(role, ["sh", "-c", "exec /usr/local/bin/twin-agent -config /run/company/agent.yaml > /run/company/agent.log 2>&1"], detach=True)
            for _ in range(60):
                status, inventory = request(tenant, "/api/inventory")
                own = {row["agent_id"]: row for row in inventory} if status == 200 else {}
                if all(own.get(agent, {}).get("last_sequence", 0) >= 3 for agent in agents[tenant].values()):
                    break
                time.sleep(1)
            else:
                raise RuntimeError("native agents did not synchronize repeated collections")
            checks[tenant + "_native_heartbeat_synchronized"] = True
            status, body = request(tenant, "/api/company/artifacts", "POST", artifact.model_dump())
            assert status == 201, body
            for _ in range(60):
                status, queued = request(tenant, "/api/company/runs", "POST", {"artifact_id": artifact.artifact_id})
                if status == 202:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("native discovery did not converge: " + str(queued))
            report["runs"][tenant] = {"run_id": queued["run_id"]}
            checks[tenant + "_native_discovery_admitted"] = True
            for role in ("employee", "database"):
                status, _ = request(tenant, "/api/assets/" + agents[tenant][role] + "/classification", "PUT",
                                    {"entry": role == "employee", "critical": role == "database"})
                assert status == 200
            status, paths = request(tenant, "/api/paths")
            assert status == 200 and any(p["nodes"] == list(agents[tenant].values()) for p in paths["assessments"])
            checks[tenant + "_observed_company_path_in_graph"] = True
            print(tenant, "discovered, connected, queued", flush=True)
            save()
        worker_env = {**os.environ, "PYTHONPATH": str(ROOT / "ingestion"),
            "DATABASE_URL": f"postgresql://twin:{db_password}@127.0.0.1:15432/digital_twin",
            "NEO4J_URI": "bolt://127.0.0.1:17687", "NEO4J_PASSWORD": graph_password}
        worker = [sys.executable, "-m", "twin_ingestion.company.worker", "--catalog", str(work / "catalog.json"),
                  "--max-jobs", "2", "--traces", str(output.parent / (identifier + "-traces"))]
        if args.scripted:
            worker.append("--scripted")
        print("Running two company hunts and multi-service repair verification", flush=True)
        command(worker, env=worker_env)
        for tenant in tenant_ids:
            run_id = report["runs"][tenant]["run_id"]
            status, detail = request(tenant, "/api/company/runs/" + run_id)
            report["runs"][tenant] = detail
            assert status == 200 and detail["status"] == "completed", {"tenant": tenant, "status": detail["status"], "error": detail.get("error")}
            other = tenant_ids[1] if tenant == tenant_ids[0] else tenant_ids[0]
            assert request(other, "/api/company/runs/" + run_id)[0] == 404
            assert request(other, "/api/company/runs", "POST", {"artifact_id": deployments[tenant].artifact_id})[0] == 404
            checks[tenant + "_attack_fix_retest"] = True
            checks[tenant + "_foreign_run_and_artifact_denied"] = True
            assert other not in json.dumps(detail["result"])
            checks[tenant + "_trace_and_evidence_scoped"] = True
            if not args.scripted:
                usages = [e["payload"].get("usage", {}) for e in detail["result"]["hunter"]["trace"] if e["kind"] == "hypothesis"]
                assert usages and all("gemini-3.8-flash" in u.get("response_model", "").lower() for u in usages)
                checks[tenant + "_live_expected_gemini"] = True
        print("Checking two-tenant network, credential and tool boundaries; rejecting broken repairs", flush=True)
        boundary_checks, report["repair_controls"] = company_boundary_controls(deployments, catalog)
        checks.update(boundary_checks)
        for source in sources:
            assert security(source)["verdict"] == "confirmed"
        checks["source_deployments_unchanged"] = True
        report["status"] = "passed"
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = str(exc).replace(os.environ.get("TWIN_MODEL_API_KEY", "unused-key"), "<redacted>")[:1000]
        with (work / "control-plane.log").open("w", encoding="utf-8") as log:
            subprocess.run([*compose, "logs", "--no-color", "--tail", "120"], stdout=log, stderr=log)
        raise
    finally:
        if not args.keep:
            for net in reversed(telemetry_networks):
                if control:
                    with contextlib.suppress(Exception):
                        net.disconnect(control, force=True)
            for source in reversed(sources):
                source.close()
            command([*compose, "down", "-v", "--remove-orphans"])
            report["cleanup"] = "complete" if not any(s.cleanup_errors for s in sources) else "failed"
        else:
            report["cleanup"] = "source_and_control_plane_retained_for_review"
            report["dashboard"] = "http://localhost:3001/#company"
            report["local_access_file"] = str(work / "access.json")
        client.close()
        save()
        print(json.dumps({"status": report["status"], "output": str(output), "checks": checks, "cleanup": report["cleanup"]}), flush=True)
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
