"""Database-backed identity: customers, users, memberships, invites and enrolled agents.

The platform admin creates customers in the dashboard, customers invite their own
team and enroll machines with short-lived tokens. Secrets (passwords, invite and
enrollment tokens) are stored only as hashes.

Authentication must stay synchronous and fast, so the store keeps an in-memory
snapshot that is rebuilt after every write in this process and periodically for
writes made elsewhere. The control plane is a single instance; a write through
the API is therefore visible to the very next request (immediate revocation).
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import re
import secrets
import time
from uuid import UUID, uuid4

from .security import AGENT_PATTERN, ROLES, TENANT_PATTERN

USER_PATTERN = r"[a-zA-Z0-9_.@-]{3,64}"
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, display_name text NOT NULL DEFAULT '', password_hash text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), last_login timestamptz
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','operator','admin')), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY, token_sha256 text NOT NULL UNIQUE, tenant_id text REFERENCES tenants(id) ON DELETE CASCADE,
  role text CHECK (role IN ('viewer','operator','admin')), platform_admin boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, accepted_by text, accepted_at timestamptz, revoked boolean NOT NULL DEFAULT false,
  CHECK (platform_admin OR (tenant_id IS NOT NULL AND role IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, token_sha256 text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  uses integer NOT NULL DEFAULT 0, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS enrolled_agents (
  agent_id text PRIMARY KEY, tenant_id text NOT NULL, hostname text NOT NULL DEFAULT '', os text NOT NULL DEFAULT '',
  token_id uuid, enrolled_at timestamptz NOT NULL DEFAULT now(), certificate_serial text NOT NULL,
  certificate_expires_at timestamptz NOT NULL, revoked_at timestamptz, revoked_by text
);
CREATE INDEX IF NOT EXISTS enrolled_agents_tenant ON enrolled_agents(tenant_id);
CREATE INDEX IF NOT EXISTS invites_tenant ON invites(tenant_id);
"""


class IdentityError(ValueError):
    """A user-facing validation failure (safe to return to the caller)."""


def hash_password(password: str) -> str:
    if not isinstance(password, str) or not 12 <= len(password) <= 256:
        raise IdentityError("passwords must be 12 to 256 characters")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return "scrypt${n}${r}${p}${salt}${hash}".format(**SCRYPT, salt=base64.b64encode(salt).decode(), hash=base64.b64encode(digest).decode())


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode()[:1024], salt=base64.b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(digest, base64.b64decode(expected))
    except Exception:
        return False


_DUMMY = []


def _dummy_hash() -> str:
    if not _DUMMY:
        _DUMMY.append(hash_password(secrets.token_urlsafe(16)))
    return _DUMMY[0]


def credential_fingerprint(password_hash: str, status: str) -> str:
    """Changes whenever the password or account status changes, ending existing sessions."""
    return hashlib.sha256(f"user:{status}:{password_hash}".encode()).hexdigest()


def new_secret(prefix: str) -> tuple[str, str]:
    token = f"{prefix}_{secrets.token_urlsafe(32)}"
    return token, hashlib.sha256(token.encode()).hexdigest()


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class Snapshot:
    tenants: dict = field(default_factory=dict)      # id -> {"id","name","status"}
    principals: dict = field(default_factory=dict)   # user id -> manifest-style principal row
    agents: dict = field(default_factory=dict)       # agent id -> tenant (active only)
    revoked_agents: set = field(default_factory=set)
    loaded_at: float = 0.0


class IdentityStore:
    def __init__(self, pool, reserved_tenants=(), reserved_users=()):
        self.pool = pool
        self.snapshot = Snapshot()
        # Identifiers managed by the legacy manifest file cannot be reused in the database.
        self.reserved_tenants, self.reserved_users = set(reserved_tenants), set(reserved_users)
        self._lock = asyncio.Lock()

    async def ensure_schema(self):
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute(SCHEMA)
        await self.refresh()

    async def refresh(self):
        async with self._lock:
            tenants = await self.pool.fetch("SELECT id,name,status FROM tenants")
            users = await self.pool.fetch("SELECT id,display_name,password_hash,platform_admin,status FROM users")
            members = await self.pool.fetch("SELECT tenant_id,user_id,role FROM memberships")
            agents = await self.pool.fetch("SELECT agent_id,tenant_id,revoked_at FROM enrolled_agents")
            snap = Snapshot(loaded_at=time.monotonic())
            snap.tenants = {r["id"]: {"id": r["id"], "name": r["name"], "status": r["status"]} for r in tenants}
            roles: dict[str, dict] = {}
            for r in members:
                roles.setdefault(r["user_id"], {})[r["tenant_id"]] = r["role"]
            for r in users:
                if r["status"] != "active":
                    continue
                snap.principals[r["id"]] = {
                    "id": r["id"], "kind": "password", "display_name": r["display_name"], "password_hash": r["password_hash"],
                    "token_sha256": credential_fingerprint(r["password_hash"], r["status"]), "expiry": float("inf"),
                    "memberships": roles.get(r["id"], {}), "platform_admin": bool(r["platform_admin"])}
            for r in agents:
                if r["revoked_at"] is None:
                    snap.agents[r["agent_id"]] = r["tenant_id"]
                else:
                    snap.revoked_agents.add(r["agent_id"])
            self.snapshot = snap

    async def refresh_loop(self, interval=5.0):
        while True:
            await asyncio.sleep(interval)
            try:
                await self.refresh()
            except Exception:
                pass  # Keep serving the last good snapshot; readiness reports database health.

    # ------------------------------------------------------------- setup and users

    async def needs_setup(self, manifest_has_platform_admin: bool) -> bool:
        if manifest_has_platform_admin:
            return False
        return not await self.pool.fetchval("SELECT EXISTS(SELECT 1 FROM users WHERE platform_admin)")

    def _check_user(self, user_id: str):
        if not re.fullmatch(USER_PATTERN, user_id or ""):
            raise IdentityError("usernames are 3-64 letters, digits or . _ @ -")
        if user_id in self.reserved_users:
            raise IdentityError("that username is reserved")

    async def create_platform_admin(self, user_id: str, password: str, display_name: str):
        self._check_user(user_id)
        password_hash = hash_password(password)
        async with self.pool.acquire() as conn, conn.transaction():
            # Serialize first-run setup so two browsers cannot both claim it.
            await conn.execute("SELECT pg_advisory_xact_lock(749312802)")
            if await conn.fetchval("SELECT EXISTS(SELECT 1 FROM users WHERE platform_admin)"):
                raise IdentityError("setup has already been completed")
            await conn.execute("INSERT INTO users(id,display_name,password_hash,platform_admin) VALUES($1,$2,$3,true)",
                               user_id, display_name[:80], password_hash)
        await self.refresh()

    async def verify_login(self, user_id: str, password: str) -> str | None:
        """Return the credential fingerprint for a correct password, else None (constant-ish time)."""
        row = self.snapshot.principals.get(user_id)
        stored = row["password_hash"] if row else _dummy_hash()  # Equalize timing for unknown users.
        if not verify_password(password, stored) or row is None:
            return None
        await self.pool.execute("UPDATE users SET last_login=now() WHERE id=$1", user_id)
        return row["token_sha256"]

    async def change_password(self, user_id: str, current: str, new: str):
        row = self.snapshot.principals.get(user_id)
        if row is None or not verify_password(current, row["password_hash"]):
            raise IdentityError("current password is incorrect")
        await self.pool.execute("UPDATE users SET password_hash=$2 WHERE id=$1", user_id, hash_password(new))
        await self.refresh()

    # ------------------------------------------------------------- tenants (platform admin)

    async def create_tenant(self, tenant_id: str, name: str, created_by: str):
        if not re.fullmatch(TENANT_PATTERN, tenant_id or "") or tenant_id in self.reserved_tenants:
            raise IdentityError("customer IDs are lowercase letters, digits and hyphens (max 32) and must be unused")
        if not 1 <= len(name.strip()) <= 80:
            raise IdentityError("customer names are 1-80 characters")
        try:
            await self.pool.execute("INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)", tenant_id, name.strip(), created_by)
        except Exception as exc:
            if "duplicate key" in str(exc) or exc.__class__.__name__ == "UniqueViolationError":
                raise IdentityError("a customer with that ID already exists") from None
            raise
        await self.refresh()

    async def set_tenant_status(self, tenant_id: str, status: str):
        if status not in {"active", "suspended"}:
            raise IdentityError("status must be active or suspended")
        if await self.pool.execute("UPDATE tenants SET status=$2 WHERE id=$1", tenant_id, status) == "UPDATE 0":
            raise KeyError(tenant_id)
        await self.refresh()

    async def tenant_overview(self, tenant_ids: list[str]) -> dict:
        """Health and usage only. Topology, paths and findings stay private to each customer."""
        rows = await self.pool.fetch("""
          SELECT t.id,
            (SELECT created_at FROM tenants x WHERE x.id=t.id) AS created_at,
            (SELECT count(*) FROM memberships m WHERE m.tenant_id=t.id) AS members,
            (SELECT count(*) FROM enrolled_agents a WHERE a.tenant_id=t.id AND a.revoked_at IS NULL) AS enrolled_agents,
            (SELECT count(*) FROM agent_state s WHERE s.tenant_id=t.id) AS known_agents,
            (SELECT count(*) FROM agent_state s WHERE s.tenant_id=t.id AND s.last_seen > now() - interval '5 minutes') AS reporting_agents,
            (SELECT max(s.last_seen) FROM agent_state s WHERE s.tenant_id=t.id) AS last_report,
            (SELECT count(*) FROM emulation_runs r WHERE r.tenant_id=t.id) AS runs,
            (SELECT count(*) FROM emulation_runs r WHERE r.tenant_id=t.id AND r.status IN ('queued','running')) AS active_runs,
            (SELECT count(*) FROM invites i WHERE i.tenant_id=t.id AND i.accepted_at IS NULL AND NOT i.revoked AND i.expires_at > now()) AS pending_invites
          FROM unnest($1::text[]) AS t(id)""", tenant_ids)
        return {r["id"]: dict(r) for r in rows}

    # ------------------------------------------------------------- invites

    async def create_invite(self, created_by: str, tenant_id: str | None, role: str | None,
                            platform_admin: bool = False, label: str = "", hours: int = 72) -> tuple[str, dict]:
        if not platform_admin and (tenant_id not in self.snapshot.tenants or role not in ROLES):
            raise IdentityError("invites need an existing customer and a valid role")
        if not 1 <= hours <= 336:
            raise IdentityError("invites expire after 1 to 336 hours")
        token, digest = new_secret("dti")
        identifier = uuid4()
        expires = datetime.now(timezone.utc) + timedelta(hours=hours)
        await self.pool.execute("""INSERT INTO invites(id,token_sha256,tenant_id,role,platform_admin,label,created_by,expires_at)
                                   VALUES($1,$2,$3,$4,$5,$6,$7,$8)""",
                                identifier, digest, tenant_id, role, platform_admin, label[:80], created_by, expires)
        return token, {"id": str(identifier), "tenant_id": tenant_id, "role": role, "platform_admin": platform_admin, "expires_at": expires.isoformat()}

    async def describe_invite(self, token: str) -> dict | None:
        row = await self.pool.fetchrow("""SELECT i.id,i.tenant_id,i.role,i.platform_admin,i.expires_at,t.name AS tenant_name
            FROM invites i LEFT JOIN tenants t ON t.id=i.tenant_id
            WHERE i.token_sha256=$1 AND i.accepted_at IS NULL AND NOT i.revoked AND i.expires_at > now()""", _sha(token or ""))
        return dict(row) if row else None

    async def accept_invite(self, token: str, user_id: str, password: str, display_name: str = "", existing: bool = False):
        """Create an account (or add a membership to an existing one) and consume the invite atomically."""
        self._check_user(user_id)
        new_hash = None if existing else hash_password(password)
        async with self.pool.acquire() as conn, conn.transaction():
            invite = await conn.fetchrow("""SELECT id,tenant_id,role,platform_admin FROM invites WHERE token_sha256=$1
                AND accepted_at IS NULL AND NOT revoked AND expires_at > now() FOR UPDATE""", _sha(token or ""))
            if invite is None:
                raise IdentityError("this invite is invalid, expired or already used")
            user = await conn.fetchrow("SELECT password_hash,status FROM users WHERE id=$1", user_id)
            if existing:
                if user is None or user["status"] != "active" or not verify_password(password, user["password_hash"]):
                    raise IdentityError("username or password is incorrect")
            else:
                if user is not None:
                    raise IdentityError("that username is taken; sign in with it to accept instead")
                await conn.execute("INSERT INTO users(id,display_name,password_hash) VALUES($1,$2,$3)", user_id, display_name[:80], new_hash)
            if invite["platform_admin"]:
                await conn.execute("UPDATE users SET platform_admin=true WHERE id=$1", user_id)
            else:
                await conn.execute("""INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)
                    ON CONFLICT (tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role""", invite["tenant_id"], user_id, invite["role"])
            await conn.execute("UPDATE invites SET accepted_by=$2, accepted_at=now() WHERE id=$1", invite["id"], user_id)
        await self.refresh()
        return {"tenant_id": invite["tenant_id"], "role": invite["role"], "platform_admin": invite["platform_admin"]}

    async def revoke_invite(self, tenant_id: str | None, invite_id: str):
        query = "UPDATE invites SET revoked=true WHERE id=$1 AND accepted_at IS NULL AND " + \
                ("tenant_id IS NULL AND platform_admin" if tenant_id is None else "tenant_id=$2")
        args = [UUID(invite_id)] + ([] if tenant_id is None else [tenant_id])
        if await self.pool.execute(query, *args) == "UPDATE 0":
            raise KeyError(invite_id)

    # ------------------------------------------------------------- team (customer admin)

    async def team(self, tenant_id: str) -> dict:
        members = await self.pool.fetch("""SELECT u.id,u.display_name,m.role,u.last_login,m.created_at AS joined_at
            FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.status='active' ORDER BY u.id""", tenant_id)
        invites = await self.pool.fetch("""SELECT id,role,label,created_by,created_at,expires_at FROM invites
            WHERE tenant_id=$1 AND accepted_at IS NULL AND NOT revoked AND expires_at > now() ORDER BY created_at DESC""", tenant_id)
        return {"members": [dict(r) for r in members], "invites": [{**dict(r), "id": str(r["id"])} for r in invites]}

    async def _admins_after(self, conn, tenant_id, user_id, new_role):
        rows = await conn.fetch("SELECT user_id,role FROM memberships WHERE tenant_id=$1 FOR UPDATE", tenant_id)
        roles = {r["user_id"]: r["role"] for r in rows}
        if user_id not in roles:
            raise KeyError(user_id)
        if new_role is None:
            roles.pop(user_id)
        else:
            roles[user_id] = new_role
        return sum(role == "admin" for role in roles.values())

    async def set_member_role(self, tenant_id: str, user_id: str, role: str):
        if role not in ROLES:
            raise IdentityError("unknown role")
        async with self.pool.acquire() as conn, conn.transaction():
            if await self._admins_after(conn, tenant_id, user_id, role) == 0:
                raise IdentityError("a workspace needs at least one admin")
            await conn.execute("UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2", tenant_id, user_id, role)
        await self.refresh()

    async def remove_member(self, tenant_id: str, user_id: str):
        async with self.pool.acquire() as conn, conn.transaction():
            if await self._admins_after(conn, tenant_id, user_id, None) == 0:
                raise IdentityError("a workspace needs at least one admin")
            await conn.execute("DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2", tenant_id, user_id)
        await self.refresh()

    # ------------------------------------------------------------- enrollment

    async def create_enrollment_token(self, tenant_id: str, created_by: str, label: str, minutes: int, max_uses: int) -> tuple[str, dict]:
        if not 5 <= minutes <= 10080 or not 1 <= max_uses <= 1000:
            raise IdentityError("tokens last 5 minutes to 7 days and allow 1 to 1000 machines")
        token, digest = new_secret("dtk")
        identifier, expires = uuid4(), datetime.now(timezone.utc) + timedelta(minutes=minutes)
        await self.pool.execute("""INSERT INTO enrollment_tokens(id,tenant_id,token_sha256,label,created_by,expires_at,max_uses)
                                   VALUES($1,$2,$3,$4,$5,$6,$7)""", identifier, tenant_id, digest, label[:80], created_by, expires, max_uses)
        return token, {"id": str(identifier), "label": label[:80], "expires_at": expires.isoformat(), "max_uses": max_uses, "uses": 0}

    async def enrollment_tokens(self, tenant_id: str) -> list[dict]:
        rows = await self.pool.fetch("""SELECT id,label,created_by,created_at,expires_at,max_uses,uses,revoked,
            (NOT revoked AND expires_at > now() AND uses < max_uses) AS usable
            FROM enrollment_tokens WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50""", tenant_id)
        return [{**dict(r), "id": str(r["id"])} for r in rows]

    async def revoke_enrollment_token(self, tenant_id: str, token_id: str):
        if await self.pool.execute("UPDATE enrollment_tokens SET revoked=true WHERE id=$1 AND tenant_id=$2",
                                   UUID(token_id), tenant_id) == "UPDATE 0":
            raise KeyError(token_id)

    async def enroll(self, token: str, issue, hostname: str, os_name: str, tenant_active) -> dict:
        """Consume one use of a token and register the agent identity issued by `issue(agent_id)`."""
        agent_id = secrets.token_hex(16)
        async with self.pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow("""UPDATE enrollment_tokens SET uses=uses+1
                WHERE token_sha256=$1 AND NOT revoked AND expires_at > now() AND uses < max_uses
                RETURNING id, tenant_id""", _sha(token or ""))
            if row is None or not tenant_active(row["tenant_id"]):
                raise IdentityError("enrollment token is invalid, expired or used up")
            certificate, serial, not_after = issue(agent_id)
            await conn.execute("""INSERT INTO enrolled_agents(agent_id,tenant_id,hostname,os,token_id,certificate_serial,certificate_expires_at)
                VALUES($1,$2,$3,$4,$5,$6,$7)""", agent_id, row["tenant_id"], hostname, os_name, row["id"], serial, not_after)
        await self.refresh()
        return {"agent_id": agent_id, "tenant_id": row["tenant_id"], "certificate": certificate, "token_id": str(row["id"])}

    async def hosts(self, tenant_id: str) -> list[dict]:
        rows = await self.pool.fetch("""SELECT a.agent_id,a.hostname,a.os,a.enrolled_at,a.certificate_expires_at,a.revoked_at,a.revoked_by,
              s.last_seen, s.last_sequence
            FROM enrolled_agents a LEFT JOIN agent_state s ON s.tenant_id=a.tenant_id AND s.agent_id=a.agent_id
            WHERE a.tenant_id=$1 ORDER BY a.enrolled_at DESC""", tenant_id)
        return [dict(r) for r in rows]

    async def revoke_agent(self, tenant_id: str, agent_id: str, by: str):
        if not re.fullmatch(AGENT_PATTERN, agent_id):
            raise KeyError(agent_id)
        if await self.pool.execute("UPDATE enrolled_agents SET revoked_at=now(), revoked_by=$3 WHERE agent_id=$1 AND tenant_id=$2 AND revoked_at IS NULL",
                                   agent_id, tenant_id, by) == "UPDATE 0":
            raise KeyError(agent_id)
        await self.refresh()
