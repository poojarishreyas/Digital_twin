"""Disposable, loopback-only company deployment acceptance. Requires lab PKI and Docker.

Starts its own Compose project, uses synthetic credentials, retains only sanitized
results, and removes its containers/volumes in finally. Never runs a sandbox probe.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    identifier = "dt-company-" + secrets.token_hex(4)
    args.output = args.output or ROOT / "research/results" / (identifier + ".json")
    work = ROOT / ".tools" / identifier
    auth, tls = work / "auth", work / "tls"
    auth.mkdir(parents=True)
    tls.mkdir()
    tokens = {role: secrets.token_urlsafe(48) for role in ("viewer", "operator", "admin")}
    rows = [{"id": role, "role": role, "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
             "expires_at": "2099-01-01T00:00:00Z"} for role, token in tokens.items()]
    manifest = auth / "auth.json"
    manifest.write_text(json.dumps({"version": 1, "principals": rows}), encoding="utf-8")
    openssl = shutil.which("openssl") or str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "OpenSSL-Win64/bin/openssl.exe")
    def certificate(*arguments):
        subprocess.run([openssl, *map(str, arguments)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    certificate("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", tls / "ca.key", "-out", tls / "ca.crt",
                "-subj", "/CN=Disposable company acceptance CA", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash")
    certificate("req", "-newkey", "rsa:2048", "-nodes", "-keyout", tls / "privkey.pem", "-out", tls / "server.csr", "-subj", "/CN=localhost")
    (tls / "server.ext").write_text("subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n")
    certificate("x509", "-req", "-in", tls / "server.csr", "-CA", tls / "ca.crt", "-CAkey", tls / "ca.key", "-set_serial", "1", "-days", "1",
                "-extfile", tls / "server.ext", "-out", tls / "fullchain.pem")
    override = work / "compose.json"
    override.write_text(json.dumps({"services": {
        "ingestion": {"volumes": [{"type": "bind", "source": str(auth), "target": "/run/twin-auth", "read_only": True}]},
        "gateway": {"volumes": [{"type": "bind", "source": str(tls), "target": "/etc/twin-tls", "read_only": True}]}
    }}), encoding="utf-8")
    env = {**os.environ, "POSTGRES_PASSWORD": secrets.token_hex(24), "NEO4J_PASSWORD": secrets.token_hex(24),
           "TWIN_AGENT_BIND": "127.0.0.1", "TWIN_WEB_BIND": "127.0.0.1", "TWIN_PUBLIC_ORIGIN": "https://localhost",
           "TWIN_AUTH_MODE": "tokens", "TWIN_API_TOKEN": tokens["operator"], "TWIN_API_URL": "https://localhost",
           "TWIN_API_CA": str(tls / "ca.crt")}
    compose = ["docker", "compose", "--progress", "plain", "-p", identifier, "-f", str(ROOT / "docker-compose.yml"),
               "-f", str(ROOT / "deploy/company/compose.yml"), "-f", str(override)]
    context = ssl.create_default_context(cafile=env["TWIN_API_CA"])
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "environment": "Windows Docker Desktop; loopback HTTPS; synthetic telemetry",
              "checks": {}, "limitations": ["Not native Windows/Linux enrollment or dedicated Linux sandbox isolation",
                  "No live AI hunt, organizational SSO/MFA or external security review tested",
                  "Cold restore result, when present, covers synthetic local data only; no site recovery SLA",
                  "Browser bundle built; interactive visual browser verification unavailable"]}
    checks = report["checks"]
    recovery_compose = None

    def request(path, role=None, method="GET", body=None, opener=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if role:
            headers["Authorization"] = "Bearer " + tokens[role]
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request("https://localhost" + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            response = opener.open(req, timeout=10) if opener else urllib.request.urlopen(req, context=context, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, raw, response.headers

    try:
        subprocess.run(compose + ["up", "-d", "--build", "--wait", "--wait-timeout", "180"], env=env, cwd=ROOT, check=True)
        assert request("/readyz")[0] == 200
        checks["https_dependency_readiness"] = True
        status, _, headers = request("/")
        assert status == 200 and "max-age" in headers.get("Strict-Transport-Security", "")
        assert "frame-ancestors 'none'" in headers.get("Content-Security-Policy", "")
        checks["https_ui_security_headers"] = True
        assert request("/api/topology")[0] == 401
        assert request("/metrics")[0] == 401
        assert request("/api/topology", "viewer")[0] == 200
        assert request("/api/assets/test/classification", "viewer", "PUT", {})[0] == 403
        assert request("/api/admin/audit", "operator")[0] == 403
        checks["api_role_boundaries"] = True
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(jar))
        status, _, headers = request("/api/auth/login", method="POST", body={"token": tokens["operator"]}, opener=opener, origin="https://localhost")
        assert status == 200 and all(flag in headers["Set-Cookie"] for flag in ("Secure", "HttpOnly", "SameSite=strict"))
        assert request("/api/topology", opener=opener)[0] == 200
        assert request("/api/assets/test/classification", method="PUT", body={}, opener=opener)[0] == 403
        checks["session_cookie_and_csrf"] = True
        output = subprocess.check_output([sys.executable, str(ROOT / "research/audit_ingestion.py")], env=env, cwd=ROOT, text=True)
        checks["authenticated_ingestion_regression"] = json.loads(output)
        # Directory mount ensures atomic credential rotation remains visible in container.
        rows[1]["token_sha256"] = hashlib.sha256(secrets.token_bytes(48)).hexdigest()
        temporary = auth / "replacement.json"
        temporary.write_text(json.dumps({"version": 1, "principals": rows}), encoding="utf-8")
        os.replace(temporary, manifest)
        assert request("/api/topology", opener=opener)[0] == 401
        assert request("/api/topology", "operator")[0] == 401
        checks["live_credential_and_session_revocation"] = True
        status, raw, _ = request("/api/admin/audit", "admin")
        audit_rows = json.loads(raw)
        assert status == 200 and any(r["stage"] == "denied" for r in audit_rows) and any(r["actor"] == "operator" and r["action"] == "asset.classify" for r in audit_rows)
        assert all(token.encode() not in raw for token in tokens.values())
        checks["durable_sanitized_audit"] = True
        logs = subprocess.check_output(compose + ["logs", "--no-color", "ingestion", "ui", "gateway"], env=env, cwd=ROOT)
        assert b"seeded-audit-secret" not in logs and all(t.encode() not in logs for t in tokens.values())
        checks["seeded_secrets_absent_from_logs"] = True
        queue_script = '''
import asyncio, os, asyncpg
from twin_ingestion.phase2.store import RunStore
async def main():
    pool = await asyncpg.create_pool(os.environ['DATABASE_URL'])
    store = RunStore(pool)
    plan = await store.create_plan('default', {'waves':[{'index':0}],'budget':{'cpu_millis':1000,'ram_mb':1024}}, [], {})
    results = await asyncio.gather(*(store.queue('default', plan, 2) for _ in range(8)), return_exceptions=True)
    assert sum(isinstance(r, str) for r in results) == 2
    assert sum(isinstance(r, ValueError) for r in results) == 6
    await pool.close()
asyncio.run(main())
'''
        subprocess.run(compose + ["exec", "-T", "ingestion", "python", "-"], input=queue_script, text=True, env=env, cwd=ROOT, check=True)
        checks["concurrent_queue_capacity"] = True
        subprocess.run(compose + ["restart", "ingestion"], env=env, cwd=ROOT, check=True)
        for _ in range(30):
            try:
                if request("/readyz")[0] == 200:
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(1)
        assert request("/readyz")[0] == 200
        assert request("/api/admin/audit", "admin")[0] == 200
        checks["restart_readiness_and_audit_persistence"] = True
        before_graph = json.loads(request("/api/topology", "admin")[1])
        original_ids = {r["id"] for r in json.loads(request("/api/admin/audit", "admin")[1])}
        subprocess.run(compose + ["stop", "-t", "30"], env=env, cwd=ROOT, check=True)
        sys.path.insert(0, str(ROOT / "deploy/ops"))
        from cold_backup import archive, restore
        backup_dir = work / "backup"
        archive(identifier, backup_dir)
        recovery_id = identifier + "-recovery"
        restore(backup_dir, recovery_id)
        recovery_compose = [recovery_id if part == identifier else part for part in compose]
        subprocess.run(recovery_compose + ["up", "-d", "--build", "--wait", "--wait-timeout", "180"], env=env, cwd=ROOT, check=True)
        assert request("/readyz")[0] == 200
        after_graph = json.loads(request("/api/topology", "admin")[1])
        assert {n["id"] for n in before_graph["nodes"]} == {n["id"] for n in after_graph["nodes"]}
        assert len(before_graph["edges"]) == len(after_graph["edges"])
        restored_audit = {r["id"] for r in json.loads(request("/api/admin/audit", "admin")[1])}
        assert original_ids & restored_audit == original_ids
        checks["cold_backup_restored_both_stores_in_fresh_project"] = True
        report["backup_bytes"] = sum(p.stat().st_size for p in backup_dir.glob("*.tar.gz"))
        report["status"] = "passed"
    finally:
        if recovery_compose:
            subprocess.run(recovery_compose + ["down", "-v", "--remove-orphans"], env=env, cwd=ROOT, check=True)
        cleaned = subprocess.run(compose + ["down", "-v", "--remove-orphans"], env=env, cwd=ROOT).returncode == 0
        report["cleanup"] = "complete" if cleaned else "failed"
        report.setdefault("status", "failed")
        # Only task-owned private files are removed; preserve sanitized report.
        for file in (tls / "privkey.pem", tls / "ca.key", manifest):
            file.unlink(missing_ok=True)
        # These archives contain task-only database credentials; do not retain them.
        for file in (work / "backup").glob("*.tar.gz"):
            file.unlink()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "cleanup": report["cleanup"], "report": str(args.output)}))


if __name__ == "__main__":
    main()
