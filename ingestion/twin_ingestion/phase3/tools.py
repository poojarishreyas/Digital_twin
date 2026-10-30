from __future__ import annotations

import ipaddress
import re
import time
from urllib.parse import urlsplit, urljoin
from .contracts import Limits, digest
from .runtime import clean_state


class Blocked(ValueError):
    pass


class ToolExecutor:
    def __init__(self, lab, limits: Limits, patch_verifier=None):
        self.lab, self.limits, self.patch_verifier = lab, limits, patch_verifier
        self.started, self.last_call, self.calls = time.monotonic(), 0.0, 0
        self.evidence, self.patches = [], []

    def _charge(self):
        self.calls += 1
        if self.calls > self.limits.max_steps:
            raise Blocked("tool step limit")
        wait = max(0, 1 / self.limits.requests_per_second - (time.monotonic() - self.last_call))
        if time.monotonic() - self.started + wait + self.limits.timeout_seconds > self.limits.max_seconds:
            raise Blocked("tool wall-time limit")
        time.sleep(wait)
        self.last_call = time.monotonic()

    def _target(self, target_id, port):
        target = self.lab.registry.get(target_id)
        if target is None or target.port != port:
            raise Blocked("target or port not registered for this run")
        ipaddress.ip_address(target.ip)
        # Verify Docker's resolver result and pin all packets to the recorded IP.
        remaining = self.limits.max_seconds - (time.monotonic() - self.started)
        if remaining <= 0:
            raise Blocked("tool wall-time limit")
        code, output = self.lab.command(target_id, ["getent", "hosts", target.host], min(self.limits.timeout_seconds, remaining))
        addresses = {line.split()[0] for line in output.splitlines() if line.split()}
        if code or addresses != {target.ip}:
            raise Blocked("resolved destination differs from registry")
        return target

    def _cmd(self, target, argv):
        remaining = self.limits.max_seconds - (time.monotonic() - self.started)
        if remaining <= 0:
            raise Blocked("tool wall-time limit")
        return self.lab.command(target.id, argv, min(self.limits.timeout_seconds, remaining))

    def _http(self, target, method, path, redirects=0):
        current = f"http://{target.host}:{target.port}{path}"
        observations = []
        for hop in range(redirects + 1):
            parsed = urlsplit(current)
            if parsed.scheme != "http" or parsed.hostname != target.host or parsed.port != target.port or parsed.username or parsed.password or parsed.fragment:
                raise Blocked("redirect destination outside target registry")
            if parsed.path not in {"/", "/health"} or parsed.query:
                raise Blocked("redirect path not allowlisted")
            if hop:
                self._charge()
                self._target(target.id, target.port)
            code, output = self._cmd(target, ["curl", "--noproxy", "*", "-sS", "-i", "--max-time", "3",
                "--max-filesize", "65536", "--request", method, "--resolve",
                f"{target.host}:{target.port}:{target.ip}", current])
            status = re.search(r"^HTTP/\S+ (\d+)", output)
            status = int(status[1]) if status else 0
            observations.append({"exit_code": code, "status": status, "response": output[:3000]})
            location = re.search(r"(?im)^location:\s*([^\r\n]+)", output)
            if not (300 <= status < 400 and location):
                return observations
            candidate = urljoin(current, location[1].strip())
            parsed_next = urlsplit(candidate)
            # Validate even when redirect following is disabled.
            if parsed_next.hostname != target.host or parsed_next.scheme != "http" or parsed_next.port != target.port:
                raise Blocked("redirect destination outside target registry")
            current = candidate
        return observations

    def _database(self, target, authenticated=False):
        if target.kind != "postgresql":
            raise Blocked("database probe requires PostgreSQL target")
        return self._cmd(target, ["env", "PGPASSWORD=lab-only-password" if authenticated else "PGPASSWORD=",
            "psql", "-w", "-h", target.ip, "-p", str(target.port), "-U", "synthetic", "-d", "synthetic", "-tAc", "SELECT 1"])

    @staticmethod
    def _analyze_headers(output):
        import re as _re
        present = {line.split(":", 1)[0].strip().lower() for line in output.splitlines() if ":" in line}
        wanted = ["strict-transport-security", "x-content-type-options", "x-frame-options", "content-security-policy"]
        return {"security_headers_present": sorted(h for h in wanted if h in present),
                "security_headers_missing": sorted(h for h in wanted if h not in present),
                "version_disclosed": bool(_re.search(r"(?im)^server:\s*\S+/[0-9]", output))}

    @staticmethod
    def _ssh_methods(output):
        import re as _re
        match = _re.search(r"Permission denied \(([^)]*)\)", output)
        return sorted(m for m in (match.group(1).split(",") if match else []) if m)

    def security(self, target):
        """Interpret actual responses; source configuration never chooses verdict."""
        verdict, observations = "inconclusive", {}
        if target.kind == "nginx":
            responses = self._http(target, "GET", "/")
            response = responses[-1]
            observations = response
            if self.lab.scenario.get("test") == "proxy_chain":
                backend = self.lab.scenario["services"][-1]["id"]
                marker = __import__("hashlib").sha256(backend.encode()).hexdigest()[:12]
                if response["exit_code"] == 0:
                    verdict = "confirmed" if f"synthetic twin {marker}" in response["response"] else "not_reproduced" if response["status"] == 403 else "inconclusive"
            elif response["exit_code"] == 0 and response["status"] == 200:
                verdict = "confirmed" if re.search(r"(?im)^server:\s*nginx/[0-9]", response["response"]) else "not_reproduced"
        elif target.kind == "redis":
            code, output = self._cmd(target, ["redis-cli", "-h", target.ip, "-p", str(target.port), "--raw", "PING"])
            observations = {"exit_code": code, "response": output}
            verdict = "confirmed" if code == 0 and output.strip() == "PONG" else "not_reproduced" if any(x in output for x in ("NOAUTH", "DENIED")) else "inconclusive"
        elif target.kind == "postgresql":
            code, output = self._database(target)
            observations = {"exit_code": code, "response": output}
            verdict = "confirmed" if code == 0 and output.strip() == "1" else "not_reproduced" if any(x in output for x in ("no password supplied", "rejects connection", "password authentication failed")) else "inconclusive"
        elif target.kind == "openssh":
            code, output = self._ssh(target)
            observations = {"exit_code": code, "response": output}
            verdict = "confirmed" if code == 0 else "not_reproduced" if "Permission denied" in output else "inconclusive"
        return {"verdict": verdict, "observations": observations, "test_id": self.lab.scenario.get("test", target.kind + ".policy"), "test_version": "3.0"}

    def _ssh(self, target):
        return self._cmd(target, ["sshpass", "-p", "lab-only-password", "ssh", "-p", str(target.port),
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "PreferredAuthentications=password",
            "-o", "PubkeyAuthentication=no", "-o", "ConnectTimeout=3", "synthetic@" + target.ip, "printf legitimate-workflow"])

    def legitimate(self, target):
        if target.kind == "postgresql":
            code, output = self._database(target, True)
            return code == 0 and output.strip() == "1"
        if target.kind == "redis":
            auth = ["--no-auth-warning", "-a", "lab-only-password"] if any(d["name"] == "requirepass" for d in self.lab.service(target.id).get("directives", [])) else []
            prefix = ["redis-cli", "-h", target.ip, "-p", str(target.port), "--raw", *auth]
            self._charge()
            code, output = self._cmd(target, [*prefix, "SET", "twin:workflow", "synthetic-value"])
            self._charge()
            code2, output2 = self._cmd(target, [*prefix, "GET", "twin:workflow"])
            return code == 0 and output.strip() == "OK" and code2 == 0 and output2.strip() == "synthetic-value"
        if target.kind == "openssh":
            return self._ssh(target)[0] == 0
        response = self._http(target, "GET", "/")[-1]
        return response["exit_code"] == 0 and response["status"] == 200 and "synthetic twin" in response["response"]

    def execute(self, action):
        self._charge()
        target = self._target(action.target_id, action.port)
        if action.name == "inspect_config":
            result = {"status": "observed", "untrusted_configuration": clean_state(self.lab.service(target.id))}
        elif action.name == "security_check":
            result = self.security(target)
        elif action.name == "http_probe":
            if target.kind != "nginx":
                raise Blocked("HTTP requires HTTP service")
            result = {"status": "observed", "responses": self._http(target, action.method, action.path, action.redirects)}
        elif action.name == "database_probe":
            code, output = self._database(target, action.authenticated)
            result = {"status": "observed", "exit_code": code, "response": output}
        elif action.name == "tcp_probe":
            code, output = self._cmd(target, ["nc", "-z", "-w", "2", target.ip, str(target.port)])
            result = {"status": "observed", "connected": code == 0}
        elif action.name == "scan_service":
            code, output = self._cmd(target, ["nmap", "-sT", "-Pn", "-n", "-p", str(target.port), "--max-retries", "1", "--host-timeout", "3s", target.ip])
            result = {"status": "observed", "exit_code": code, "response": output}
        elif action.name == "run_nuclei":
            if target.kind != "nginx":
                raise Blocked("template supports Nginx only")
            code, output = self._cmd(target, ["nuclei", "-t", "/run/twin/nginx-header.yaml", "-u", f"http://{target.ip}:{target.port}",
                "-disable-update-check", "-no-interactsh", "-rate-limit", "1", "-concurrency", "1", "-timeout", "2", "-retries", "0", "-jsonl"])
            result = {"status": "observed", "exit_code": code, "response": output}
        elif action.name == "http_headers":
            if target.kind != "nginx":
                raise Blocked("http_headers requires an HTTP service")
            code, output = self._cmd(target, ["curl", "-sS", "-I", "--max-time", "4", f"http://{target.ip}:{target.port}/"])
            result = {"status": "observed", **self._analyze_headers(output), "exit_code": code}
        elif action.name == "redis_config":
            if target.kind != "redis":
                raise Blocked("redis_config requires a Redis service")
            code, output = self._cmd(target, ["redis-cli", "-h", target.ip, "-p", str(target.port), "--no-auth-warning",
                                              "CONFIG", "GET", action.parameter])
            result = {"status": "observed", "parameter": action.parameter,
                      "value": output.splitlines()[-1].strip() if code == 0 and output.strip() else "",
                      "authentication_required": "NOAUTH" in output.upper(), "exit_code": code}
        elif action.name == "ssh_auth_methods":
            if target.kind != "openssh":
                raise Blocked("ssh_auth_methods requires an OpenSSH service")
            code, output = self._cmd(target, ["ssh", "-o", "BatchMode=yes", "-o", "PreferredAuthentications=none",
                                              "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=4",
                                              "-p", str(target.port), f"probe@{target.ip}"])
            result = {"status": "observed", "offered_methods": self._ssh_methods(output), "exit_code": code}
        elif action.name == "test_patch":
            if self.patch_verifier is None:
                raise Blocked("patch verifier unavailable")
            result = self.patch_verifier(action)
            self.patches.append(result)
        else:
            raise Blocked("unknown tool")
        result = {**result, "target_id": target.id, "snapshot_hash": target.snapshot_hash,
                  "image_id": target.image_id, "fidelity_gaps": target.fidelity_gaps, "tool": action.name,
                  "test_version": "3.0", "probe_image_id": self.lab.probes[target.id].image.id if hasattr(self.lab, "probes") else "test-double"}
        result["evidence_id"] = digest(result)
        self.evidence.append(result)
        return result
