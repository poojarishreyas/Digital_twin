"""Read-only company deployment checks. Prints statuses, never resolved secrets."""
import ipaddress
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    checks = []
    def add(name, passed, detail):
        checks.append({"check": name, "passed": bool(passed), "detail": detail})
    free = shutil.disk_usage(ROOT).free
    add("operator_disk_headroom", free >= 5 * 1024**3, f"{free // 1024**2} MiB free; minimum 5 GiB for this preflight, size actual databases separately")
    try:
        engine = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, timeout=15)
        add("docker_engine", engine.returncode == 0, "reachable" if engine.returncode == 0 else "Docker engine unavailable")
        result = subprocess.run(["docker", "compose", "-f", "docker-compose.yml", "-f", "deploy/company/compose.yml", "config", "--format", "json"],
                                cwd=ROOT, capture_output=True, timeout=15)
        add("company_compose_configuration", result.returncode == 0, "resolved internally; credentials omitted" if result.returncode == 0 else "required .env values missing or Compose configuration invalid")
        if result.returncode == 0:
            services = json.loads(result.stdout)["services"]
            add("databases_internal", all(not services[name].get("ports") for name in ("postgres", "neo4j")), "company databases must have no host publications")
            ports = services["gateway"].get("ports", []) + services["ingestion"].get("ports", [])
            private = all(p.get("host_ip") and ipaddress.ip_address(p["host_ip"]).is_private
                          and not ipaddress.ip_address(p["host_ip"]).is_unspecified for p in ports)
            add("private_interface_bindings", private and len(ports) == 2, "bind only an explicit private interface or loopback")
            env = services["ingestion"]["environment"]
            sys.path.insert(0, str(ROOT / "ingestion"))
            from twin_ingestion.settings import Settings
            from twin_ingestion.security import AuthManager
            try:
                AuthManager(Settings(deployment_mode="company", auth_mode=env["TWIN_AUTH_MODE"],
                    allowed_origins=env["TWIN_ALLOWED_ORIGINS"], cookie_secure=env["TWIN_COOKIE_SECURE"] == "true",
                    auth_file=str(ROOT / "secrets/auth/auth.json"), database_url=env["DATABASE_URL"], neo4j_password=env["NEO4J_PASSWORD"]))
                add("authentication_and_credentials", True, "company startup requirements pass")
            except (ValueError, RuntimeError):
                add("authentication_and_credentials", False, "manifest or company security settings invalid; inspect locally without sharing secrets")
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, ImportError):
        add("preflight_dependencies", False, "install repository Python dependencies and Docker Compose; inspect configuration locally")
    for name in ("secrets/tls/fullchain.pem", "secrets/tls/privkey.pem", "certs/ca.crt", "certs/server.crt", "certs/server.key"):
        add("file:" + name, (ROOT / name).is_file(), "required deployment file presence; certificate validity and trust need separate checks")
    passed = all(c["passed"] for c in checks)
    print(json.dumps({"status": "passed" if passed else "not_ready", "checks": checks,
                      "scope": "Configuration preflight only; not a security assessment, TLS validation, restore test or sandbox isolation test"}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
