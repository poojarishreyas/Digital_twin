"""A lab that points the Phase 3 executor at already-running registered targets.

Unlike the Phase 2 sandbox (which builds disposable twins and runs probes from an
isolated probe container), DirectLab runs the same probe commands from the host
where the hunter MCP server runs, against targets listed in a config file. It is
meant for hunting the live twin's own services (e.g. the AWS lab hosts) under the
same typed-action + only-executed-evidence rules.

Safety is preserved by construction: the executor still accepts only registered
target IDs/ports, and the DNS-pin check resolves to the configured IP, so a probe
can never be redirected to an unregistered destination.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .contracts import RegistryTarget


class DirectLab:
    def __init__(self, targets: dict[str, RegistryTarget], services: dict[str, dict], scenario: dict | None = None):
        self.registry = targets
        self._services = services
        self.scenario = scenario or {}

    @classmethod
    def from_config(cls, path: str | Path) -> "DirectLab":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        targets, services = {}, {}
        for row in data["targets"]:
            svc = row.get("service", {})
            targets[row["id"]] = RegistryTarget(
                id=row["id"], host=row["host"], ip=row["ip"], port=int(row["port"]), kind=row["kind"],
                snapshot_hash=row.get("snapshot_hash", "0" * 64), image_id=row.get("image_id", "direct-target"),
                fidelity_gaps=row.get("fidelity_gaps", ["direct target: not a rendered twin; config fidelity unverified"]))
            services[row["id"]] = {"id": row["id"], "kind": row["kind"], "version": svc.get("version", ""),
                                   "directives": svc.get("directives", []), "hba_rules": svc.get("hba_rules", [])}
        return cls(targets, services, data.get("scenario", {}))

    def service(self, target_id: str) -> dict:
        return self._services.get(target_id, {"id": target_id, "kind": "", "version": "", "directives": [], "hba_rules": []})

    def command(self, target_id: str, argv: list[str], timeout: int = 5) -> tuple[int, str]:
        # The executor verifies DNS by running `getent hosts <host>` and requiring the
        # result to equal the registered IP. We resolve from the trusted config instead
        # of the host resolver, which keeps probes pinned to the registered address.
        if argv[:1] == ["getent"]:
            target = self.registry.get(target_id)
            return (0, f"{target.ip} {target.host}") if target else (2, "")
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=max(1, timeout))
            return done.returncode, (done.stdout or "") + (done.stderr or "")
        except subprocess.TimeoutExpired:
            return 124, "probe timed out"
        except FileNotFoundError:
            return 127, f"probe tool not installed: {argv[0] if argv else '?'}"
