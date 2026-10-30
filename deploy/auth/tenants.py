"""Manage tenants, agent enrollment and per-tenant memberships in the auth manifest.

Credentials are written to private files and never printed. Examples:

  python deploy/auth/tenants.py create-tenant acme --name "Acme Corp"
  python deploy/auth/tenants.py grant alice --tenant acme --role admin
  python deploy/auth/tenants.py grant alice --tenant globex --role viewer      # second workspace
  python deploy/auth/tenants.py register-agent <certificate-common-name> --tenant acme
  python deploy/auth/tenants.py suspend acme
  python deploy/auth/tenants.py list

A version 1 (single-company) manifest is upgraded in place: its principals join the
`default` tenant and unregistered agents keep reporting there until you register
them and run `set-agent-fallback --none`.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

TENANT = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
PRINCIPAL = re.compile(r"[a-zA-Z0-9_.-]{1,64}")
AGENT = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
ROLES = ("viewer", "operator", "admin")


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load(path):
    if not path.exists():
        return {"version": 2, "tenants": [], "principals": [], "agents": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") == 1:
        return {
            "version": 2,
            "tenants": [{"id": "default", "name": "Default workspace", "status": "active"}],
            "principals": [{"id": row["id"], "token_sha256": row["token_sha256"], "expires_at": row["expires_at"],
                            "memberships": [{"tenant": "default", "role": row["role"]}]} for row in data["principals"]],
            "agents": [],
            "default_agent_tenant": "default",
        }
    if data.get("version") != 2:
        raise SystemExit("unsupported manifest version")
    data.setdefault("agents", [])
    return data


def save(path, data):
    atomic_write(path, json.dumps(data, indent=2) + "\n")
    if not data["principals"]:
        print("Warning: no principals yet; the server refuses to start until you run `grant`.")


def tenant_row(data, tenant):
    row = next((t for t in data["tenants"] if t["id"] == tenant), None)
    if row is None:
        raise SystemExit(f"tenant {tenant!r} does not exist; run create-tenant first")
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--auth-file", type=Path, default=Path("secrets/auth/auth.json"))
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-tenant")
    create.add_argument("tenant")
    create.add_argument("--name", required=True)
    for name in ("suspend", "activate"):
        commands.add_parser(name).add_argument("tenant")
    register = commands.add_parser("register-agent", help="bind a certificate common name to one tenant")
    register.add_argument("agent_id")
    register.add_argument("--tenant", required=True)
    commands.add_parser("unregister-agent").add_argument("agent_id")
    fallback = commands.add_parser("set-agent-fallback", help="tenant for unregistered agents (single-company upgrade)")
    group = fallback.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant")
    group.add_argument("--none", action="store_true")
    grant = commands.add_parser("grant", help="add or change a membership; issues a credential for new principals")
    grant.add_argument("principal")
    grant.add_argument("--tenant", required=True)
    grant.add_argument("--role", choices=ROLES, required=True)
    grant.add_argument("--days", type=int, default=30)
    grant.add_argument("--token-file", type=Path)
    grant.add_argument("--rotate", action="store_true", help="issue a new credential, invalidating the previous one")
    revoke = commands.add_parser("revoke", help="remove a membership (or the principal when it has none left)")
    revoke.add_argument("principal")
    revoke.add_argument("--tenant", required=True)
    commands.add_parser("list")
    args = parser.parse_args()
    data = load(args.auth_file)

    if args.command == "list":
        for tenant in data["tenants"]:
            members = [f"{p['id']}:{m['role']}" for p in data["principals"] for m in p["memberships"] if m["tenant"] == tenant["id"]]
            agents = sum(1 for a in data["agents"] if a["tenant"] == tenant["id"])
            print(f"{tenant['id']:<20} {tenant.get('status', 'active'):<10} agents={agents:<4} {tenant['name']}  [{', '.join(members)}]")
        print(f"unregistered agents -> {data.get('default_agent_tenant') or 'refused'}")
        return

    if args.command == "create-tenant":
        if not TENANT.fullmatch(args.tenant) or not 1 <= len(args.name) <= 80:
            parser.error("tenant IDs are lowercase letters, digits and hyphens (max 32); names are 1-80 characters")
        if any(t["id"] == args.tenant for t in data["tenants"]):
            parser.error("tenant exists")
        data["tenants"].append({"id": args.tenant, "name": args.name, "status": "active"})
    elif args.command in {"suspend", "activate"}:
        tenant_row(data, args.tenant)["status"] = "suspended" if args.command == "suspend" else "active"
    elif args.command == "register-agent":
        tenant_row(data, args.tenant)
        if not AGENT.fullmatch(args.agent_id):
            parser.error("invalid agent identity")
        existing = next((a for a in data["agents"] if a["id"] == args.agent_id), None)
        if existing and existing["tenant"] != args.tenant:
            parser.error(f"agent is enrolled in {existing['tenant']!r}; unregister it first (its history stays with that tenant)")
        if not existing:
            data["agents"].append({"id": args.agent_id, "tenant": args.tenant})
    elif args.command == "unregister-agent":
        data["agents"] = [a for a in data["agents"] if a["id"] != args.agent_id]
    elif args.command == "set-agent-fallback":
        if args.none:
            data.pop("default_agent_tenant", None)
        else:
            tenant_row(data, args.tenant)
            data["default_agent_tenant"] = args.tenant
    elif args.command == "grant":
        tenant_row(data, args.tenant)
        if not PRINCIPAL.fullmatch(args.principal) or not 1 <= args.days <= 90:
            parser.error("use an alphanumeric principal ID and expiry between 1 and 90 days")
        row = next((p for p in data["principals"] if p["id"] == args.principal), None)
        issue = row is None or args.rotate
        if row is None:
            row = {"id": args.principal, "token_sha256": "", "expires_at": "", "memberships": []}
            data["principals"].append(row)
        row["memberships"] = [m for m in row["memberships"] if m["tenant"] != args.tenant] + [{"tenant": args.tenant, "role": args.role}]
        if issue:
            token_path = args.token_file or Path("secrets/credentials") / (args.principal + ".token")
            if token_path.resolve() == args.auth_file.resolve() or (token_path.exists() and not args.rotate):
                parser.error("token file exists or conflicts with the manifest")
            token = secrets.token_urlsafe(48)
            row["token_sha256"] = hashlib.sha256(token.encode()).hexdigest()
            row["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=args.days)).isoformat()
            atomic_write(token_path, token + "\n")
            print(f"Credential written to {token_path}. Deliver it privately.")
    elif args.command == "revoke":
        row = next((p for p in data["principals"] if p["id"] == args.principal), None)
        if row is None:
            parser.error("principal not found")
        row["memberships"] = [m for m in row["memberships"] if m["tenant"] != args.tenant]
        if not row["memberships"]:
            data["principals"].remove(row)
    save(args.auth_file, data)
    print(f"Manifest updated: {args.auth_file}. The server re-reads it on every request.")


if __name__ == "__main__":
    main()
