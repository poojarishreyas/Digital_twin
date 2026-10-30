"""Issue a per-person credential in a single-company (version 1) manifest.

For multi-tenant deployments use deploy/auth/tenants.py. Never print the credential to stdout/logs.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", required=True)
    parser.add_argument("--role", choices=["viewer", "operator", "admin"], required=True)
    parser.add_argument("--auth-file", type=Path, default=Path("secrets/auth/auth.json"))
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--rotate", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", args.id) or not 1 <= args.days <= 90:
        parser.error("use an alphanumeric ID and expiry between 1 and 90 days")
    data = json.loads(args.auth_file.read_text(encoding="utf-8")) if args.auth_file.exists() else {"version": 1, "principals": []}
    if data.get("version") != 1:
        parser.error("this is a multi-tenant manifest; use deploy/auth/tenants.py grant --tenant ...")
    exists = any(row["id"] == args.id for row in data["principals"])
    if exists and not args.rotate:
        parser.error("principal exists; use --rotate to invalidate their previous credential and sessions")
    token_path = args.token_file or Path("secrets/credentials") / (args.id + ".token")
    if token_path.resolve() == args.auth_file.resolve() or (token_path.exists() and not args.rotate):
        parser.error("token file exists or conflicts with manifest")
    rows = [row for row in data["principals"] if row["id"] != args.id]
    if len(rows) >= 100:
        parser.error("single-company pilot supports at most 100 principals")
    token = secrets.token_urlsafe(48)
    rows.append({"id": args.id, "role": args.role, "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
                 "expires_at": (datetime.now(timezone.utc) + timedelta(days=args.days)).isoformat()})
    atomic_write(token_path, token + "\n")
    atomic_write(args.auth_file, json.dumps({"version": 1, "principals": rows}, indent=2) + "\n")
    print(f"Credential written to {token_path}; hashed manifest updated. Restrict file access and deliver the credential privately.")


if __name__ == "__main__":
    main()
