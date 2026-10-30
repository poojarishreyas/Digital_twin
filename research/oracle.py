"""Independent client observations; does not call TwinHunter tools/classifiers."""
import hashlib
import re


def verify_truth(lab):
    service = lab.scenario["services"][0]
    target = lab.registry[service["id"]]
    if target.kind == "nginx":
        code, wire = lab.command(target.id, ["curl", "--noproxy", "*", "-sS", "-D", "-", "--max-time", "3", f"http://{target.ip}:{target.port}/"])
        if code:
            return None, {"exit_code": code, "wire": wire}
        if lab.scenario["test"] == "proxy_chain":
            marker = hashlib.sha256(lab.scenario["services"][-1]["id"].encode()).hexdigest()[:12]
            truth = True if f"synthetic twin {marker}" in wire else False if "403 Forbidden" in wire else None
        else:
            truth = bool(re.search(r"(?im)^Server:\s*nginx/\d", wire)) if "200 OK" in wire else None
    elif target.kind == "redis":
        code, wire = lab.command(target.id, ["redis-cli", "--raw", "-h", target.ip, "-p", str(target.port), "PING"])
        truth = True if wire.strip() == "PONG" else False if "NOAUTH" in wire or "DENIED" in wire else None
    elif target.kind == "postgresql":
        code, wire = lab.command(target.id, ["env", "PGPASSWORD=", "psql", "-w", "-h", target.ip, "-p", str(target.port), "-U", "synthetic", "-d", "synthetic", "-At", "-c", "SELECT 1"])
        truth = True if code == 0 and wire.strip() == "1" else False if any(s in wire for s in ["no password supplied", "rejects connection", "password authentication failed"]) else None
    else:
        code, wire = lab.command(target.id, ["sshpass", "-p", "lab-only-password", "ssh", "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-o", "PreferredAuthentications=password",
            "-o", "PubkeyAuthentication=no", "-p", str(target.port), "synthetic@" + target.ip, "printf oracle-ok"])
        truth = True if code == 0 and "oracle-ok" in wire else False if "Permission denied" in wire else None
    return truth, {"exit_code": code, "wire": wire[:3000], "oracle_version": "wire-oracle-1"}
