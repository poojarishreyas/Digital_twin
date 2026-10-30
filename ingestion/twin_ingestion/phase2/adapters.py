"""Strict renderers for the four supported service families."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CATALOG = json.loads((Path(__file__).parent / "catalog.json").read_text(encoding="utf-8"))["mappings"]
TOKEN = re.compile(r"^[a-zA-Z0-9_.*:/=,+@! -]{1,256}$")


@dataclass
class Rendered:
    service: str
    image: str
    port: int
    files: dict[str, str]
    command: list[str] | None
    environment: dict[str, str]
    fidelity_gaps: list[str]
    supported: bool


ALLOWED = {
    "nginx": {"listen", "server_tokens", "allow", "deny", "client_max_body_size", "add_header", "proxy_ssl_verify", "proxy_pass"},
    "postgresql": {"listen_addresses", "port", "password_encryption", "log_connections", "log_disconnections", "max_connections"},
    "redis": {"bind", "protected-mode", "port", "requirepass", "maxmemory-policy"},
    "openssh": {"port", "listenaddress", "permitrootlogin", "passwordauthentication", "pubkeyauthentication",
                "allowusers", "denyusers", "allowgroups", "denygroups", "x11forwarding", "allowtcpforwarding", "gatewayports", "loglevel"},
}


def _value(directive: dict[str, Any]) -> str:
    values = directive.get("values", [])
    if len(values) != 1 or not isinstance(values[0], str) or not TOKEN.fullmatch(values[0]):
        raise ValueError(f"unsafe value for {directive.get('name')}")
    if "<redacted>" in values[0]:
        raise ValueError("redacted value cannot be rendered")
    return values[0]


def _version_matches(service: str, observed: str, expected: str) -> bool:
    normalized = observed.lower().replace("_", "").replace("-", "")
    return bool(re.search(rf"(?<!\d){re.escape(expected.lower())}(?!\d)", normalized))


def render(service: str, observed_version: str, directives: list[dict],
           hba_rules: list[dict] | None = None, unsupported: list[str] | None = None,
           upstream_alias: str | None = None, instance_marker: str = "synthetic") -> Rendered:
    if service not in CATALOG:
        raise ValueError(f"unsupported adapter: {service}")
    mapping = CATALOG[service]
    gaps = [f"source_directive_not_exported:{name}" for name in (unsupported or [])]
    if not _version_matches(service, observed_version, mapping["version"]):
        gaps.append(f"version_unavailable:{observed_version or 'unknown'};mapped={mapping['version']}")
    normalized = []
    for directive in sorted(directives, key=lambda d: d.get("order", 0)):
        name = str(directive.get("name", "")).lower()
        if name not in ALLOWED[service]:
            gaps.append(f"directive_unsupported:{name}")
            continue
        if service == "redis" and name == "requirepass" and directive.get("values") == ["<redacted>"]:
            normalized.append((name, "lab-only-password", directive.get("section", "")))
            gaps.append("synthetic_redis_password_substituted")
            continue
        try:
            value = _value(directive)
        except ValueError:
            gaps.append(f"directive_unrenderable:{name}")
            continue
        normalized.append((name, value, directive.get("section", "")))
    if any(g.startswith(("version_unavailable", "directive_unsupported", "directive_unrenderable", "source_directive")) for g in gaps):
        return Rendered(service, mapping["image"], mapping["port"], {}, None, {}, gaps, False)

    if service == "nginx":
        lines = ["events {}", "http {", "  server {", "    listen 8080;"]
        proxy = None
        for name, value, section in normalized:
            if section and not section.startswith("http/server"):
                gaps.append(f"section_unsupported:{section}")
                continue
            if name == "listen":
                if value != "8080":
                    gaps.append(f"network_binding_unavailable:listen={value}")
                continue
            if name == "proxy_pass":
                if upstream_alias is None or not re.fullmatch(r"[a-z0-9-]{1,63}:[0-9]{1,5}", upstream_alias):
                    gaps.append("proxy_upstream_unmapped")
                else:
                    proxy = upstream_alias
                    gaps.append("proxy_upstream_remapped_to_synthetic_twin")
                continue
            if name == "add_header" and value.lower().startswith("set-cookie"):
                gaps.append("synthetic_cookie_required")
                continue
            lines.append(f"    {name} {value};")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", instance_marker):
            raise ValueError("invalid synthetic instance marker")
        lines.append(f"    location / {{ proxy_pass http://{proxy}; }}" if proxy else
                     f"    location / {{ return 200 'synthetic twin {instance_marker}'; }}")
        lines += ["  }", "}"]
        files = {"nginx.conf": "\n".join(lines) + "\n"}
        command = ["nginx", "-g", "daemon off;", "-c", "/run/twin/nginx.conf"]
        env = {}
    elif service == "postgresql":
        settings = ["listen_addresses = '*'", "port = 5432", "hba_file = '/run/twin/pg_hba.conf'"]
        for name, value, _ in normalized:
            if name in {"listen_addresses", "port"}:
                if value not in {"*", "5432"}:
                    gaps.append(f"network_binding_unavailable:{name}={value}")
                continue
            if name == "password_encryption" and value not in {"scram-sha-256", "md5"}:
                gaps.append(f"auth_method_unsupported:{value}")
                continue
            settings.append(f"{name} = '{value}'")
        # The official entrypoint creates the synthetic database over a Unix
        # socket. This local-only bootstrap rule does not match network probes.
        rules = ["local all all trust"]
        gaps.append("synthetic_local_bootstrap_rule")
        source_rule_count = 0
        for rule in sorted(hba_rules or [], key=lambda d: d.get("order", 0)):
            fields = rule.get("values", [])
            if len(fields) < 4 or fields[0] not in {"host", "hostnossl"}:
                gaps.append("pg_hba_rule_unsupported")
                continue
            if fields[3] not in {"0.0.0.0/0", "::/0"} or fields[-1] not in {"trust", "reject", "scram-sha-256", "md5"}:
                gaps.append("pg_hba_address_or_method_unsupported")
                continue
            rules.append(" ".join([fields[0], "synthetic", "synthetic", fields[3], fields[-1]]))
            source_rule_count += 1
        if not source_rule_count:
            gaps.append("pg_hba_missing_or_unrenderable")
        files = {"postgresql.conf": "\n".join(settings) + "\n", "pg_hba.conf": "\n".join(rules) + "\n"}
        command = ["postgres", "-c", "config_file=/run/twin/postgresql.conf"]
        env = {"POSTGRES_USER": "synthetic", "POSTGRES_DB": "synthetic", "POSTGRES_PASSWORD": "lab-only-password", "PGDATA": "/var/lib/postgresql/data/pgdata"}
    elif service == "redis":
        # An explicit wildcard bind changes Redis protected-mode behavior.
        # Omit bind when the source omitted it, so the secure fixture can
        # exercise the server's real remote-client DENIED response.
        lines = ["port 6379", "save \"\"", "appendonly no"]
        for name, value, _ in normalized:
            if name == "bind":
                if value not in {"0.0.0.0", "*"}:
                    gaps.append(f"network_binding_unavailable:{name}={value}")
                else:
                    lines.append("bind 0.0.0.0")
                continue
            if name == "port":
                if value != "6379":
                    gaps.append(f"network_binding_unavailable:{name}={value}")
                continue
            lines.append(f"{name} {value}")
        files = {"redis.conf": "\n".join(lines) + "\n"}
        command = ["redis-server", "/run/twin/redis.conf"]
        env = {}
    else:
        lines = ["Port 2222", "ListenAddress 0.0.0.0", "HostKey /run/twin/ssh_host_ed25519_key", "UsePAM no", "PidFile /run/sshd.pid"]
        for name, value, section in normalized:
            if section:
                gaps.append(f"match_section_unsupported:{section}")
                continue
            if name in {"port", "listenaddress"}:
                if value not in {"2222", "0.0.0.0", "*"}:
                    gaps.append(f"network_binding_unavailable:{name}={value}")
                continue
            if name in {"allowusers", "denyusers", "allowgroups", "denygroups"} and value not in {"synthetic", "*"}:
                gaps.append(f"identity_mapping_unavailable:{name}")
                continue
            if name == "pubkeyauthentication" and value.lower() == "yes":
                gaps.append("synthetic_authorized_key_unavailable")
                continue
            lines.append(f"{name} {value}")
        files = {"sshd_config": "\n".join(lines) + "\n"}
        command = None
        env = {}
    fatal = ("network_binding_unavailable", "pg_hba_", "auth_method_unsupported", "match_section_unsupported", "identity_mapping_unavailable", "synthetic_cookie_required", "section_unsupported", "proxy_upstream_unmapped", "synthetic_authorized_key_unavailable")
    return Rendered(service, mapping["image"], mapping["port"], files, command, env, gaps,
                    not any(g.startswith(fatal) for g in gaps))

