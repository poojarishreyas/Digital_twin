"""GUI onboarding: setup, customers, invites, team, enrollment and revocation.

Runs against a real PostgreSQL when TWIN_TEST_DATABASE_URL is set (the SQL is the
point of these tests); skipped otherwise. Example:
  docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=twin_test postgres:17-alpine
  TWIN_TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55432/twin_test pytest ingestion/tests/test_identity.py
"""
import asyncio
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path

import pytest

asyncpg = pytest.importorskip("asyncpg")
httpx = pytest.importorskip("httpx")
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from twin_ingestion.api import EventHub, create_app
from twin_ingestion.enrollment import CertificateIssuer, EnrollmentError
from twin_ingestion.identity import IdentityError, IdentityStore, hash_password, verify_password
from twin_ingestion.phase2.store import RunStore
from twin_ingestion.security import AuthManager
from twin_ingestion.settings import Settings
from test_security import Audit, Graph, History

DATABASE = os.environ.get("TWIN_TEST_DATABASE_URL")
ROOT = Path(__file__).resolve().parents[2]
needs_db = pytest.mark.skipif(not DATABASE, reason="set TWIN_TEST_DATABASE_URL to run identity tests against PostgreSQL")
PASSWORD = "correct horse battery"


async def fresh_store(reserved_tenants=(), reserved_users=()):
    pool = await asyncpg.create_pool(DATABASE, min_size=1, max_size=4)
    await pool.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    await pool.execute((ROOT / "deploy/postgres/init.sql").read_text())
    await RunStore(pool).ensure_schema()
    store = IdentityStore(pool, reserved_tenants, reserved_users)
    await store.ensure_schema()
    return pool, store


def make_ca(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic Enrollment CA")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=30)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .sign(key, hashes.SHA256()))
    (tmp_path / "ca.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp_path / "ca.key").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return CertificateIssuer(str(tmp_path / "ca.crt"), str(tmp_path / "ca.key"), str(tmp_path / "ca.crt"), days=30), cert


def csr_pem(key=None, cn="attacker-chosen-name"):
    key = key or ec.generate_private_key(ec.SECP256R1())
    csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])).sign(key, hashes.SHA256())
    return csr.public_bytes(serialization.Encoding.PEM).decode()


def test_password_hashing_round_trip():
    stored = hash_password(PASSWORD)
    assert stored.startswith("scrypt$") and PASSWORD not in stored
    assert verify_password(PASSWORD, stored) and not verify_password(PASSWORD + "!", stored)
    with pytest.raises(IdentityError):
        hash_password("short")


def test_csr_checks_and_server_chosen_identity(tmp_path):
    issuer, ca = make_ca(tmp_path)
    with pytest.raises(EnrollmentError):
        issuer.check_csr("not a csr")
    with pytest.raises(EnrollmentError):
        issuer.check_csr(csr_pem(rsa.generate_private_key(public_exponent=65537, key_size=1024)))
    pem, serial, not_after = issuer.issue(issuer.check_csr(csr_pem()), "a" * 32)
    cert = x509.load_pem_x509_certificate(pem.encode())
    assert cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == "a" * 32  # Requested CN ignored.
    assert cert.issuer == ca.subject and not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    assert cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value == x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH])
    ca.public_key().verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm))


@needs_db
def test_setup_customers_invites_and_last_admin_guard():
    async def run():
        pool, store = await fresh_store(reserved_tenants={"default"}, reserved_users={"legacy-admin"})
        try:
            assert await store.needs_setup(False)
            await store.create_platform_admin("root.admin", PASSWORD, "Platform Admin")
            assert not await store.needs_setup(False)
            with pytest.raises(IdentityError):
                await store.create_platform_admin("second", PASSWORD, "")
            assert await store.verify_login("root.admin", PASSWORD) and not await store.verify_login("root.admin", "wrong password!!")
            assert not await store.verify_login("nobody", PASSWORD)

            for bad in ("default", "Bad_ID"):
                with pytest.raises(IdentityError):
                    await store.create_tenant(bad, "Name", "root.admin")
            await store.create_tenant("acme", "Acme Corp", "root.admin")
            with pytest.raises(IdentityError):
                await store.create_tenant("acme", "Again", "root.admin")

            token, _ = await store.create_invite("root.admin", "acme", "admin")
            assert (await store.describe_invite(token))["tenant_name"] == "Acme Corp"
            with pytest.raises(IdentityError):
                await store.accept_invite(token, "legacy-admin", PASSWORD)  # Reserved by the manifest file.
            await store.accept_invite(token, "ada", PASSWORD, "Ada")
            assert store.snapshot.principals["ada"]["memberships"] == {"acme": "admin"}
            with pytest.raises(IdentityError):
                await store.accept_invite(token, "eve", PASSWORD)  # Single use.

            await store.create_tenant("globex", "Globex", "root.admin")
            second, _ = await store.create_invite("root.admin", "globex", "viewer")
            with pytest.raises(IdentityError):
                await store.accept_invite(second, "ada", "not her password")
            await store.accept_invite(second, "ada", PASSWORD, existing=True)
            assert store.snapshot.principals["ada"]["memberships"] == {"acme": "admin", "globex": "viewer"}

            with pytest.raises(IdentityError, match="at least one admin"):
                await store.set_member_role("acme", "ada", "viewer")
            third, _ = await store.create_invite("ada", "acme", "admin")
            await store.accept_invite(third, "bob", PASSWORD)
            await store.set_member_role("acme", "ada", "operator")
            with pytest.raises(IdentityError, match="at least one admin"):
                await store.remove_member("acme", "bob")
            await store.remove_member("acme", "ada")
            team = await store.team("acme")
            assert [m["id"] for m in team["members"]] == ["bob"]
            overview = await store.tenant_overview(["acme", "globex"])
            assert overview["acme"]["members"] == 1 and overview["globex"]["members"] == 1
        finally:
            await pool.close()
    asyncio.run(run())


@needs_db
def test_enrollment_tokens_are_bounded_and_revocable(tmp_path):
    issuer, _ = make_ca(tmp_path)

    async def run():
        pool, store = await fresh_store()
        try:
            await store.create_tenant("acme", "Acme", "root")
            issue = lambda agent_id: issuer.issue(issuer.check_csr(csr_pem()), agent_id)
            active = lambda tenant: True
            token, info = await store.create_enrollment_token("acme", "ada", "web tier", 60, 2)
            first = await store.enroll(token, issue, "web-01", "linux", active)
            second = await store.enroll(token, issue, "web-02", "linux", active)
            assert first["tenant_id"] == "acme" and first["agent_id"] != second["agent_id"]
            with pytest.raises(IdentityError):
                await store.enroll(token, issue, "web-03", "linux", active)  # Uses exhausted.
            assert store.snapshot.agents[first["agent_id"]] == "acme"

            suspended, _ = await store.create_enrollment_token("acme", "ada", "", 60, 5)
            with pytest.raises(IdentityError):
                await store.enroll(suspended, issue, "x", "linux", lambda tenant: False)
            revoked, revoked_info = await store.create_enrollment_token("acme", "ada", "", 60, 5)
            await store.revoke_enrollment_token("acme", revoked_info["id"])
            with pytest.raises(IdentityError):
                await store.enroll(revoked, issue, "x", "linux", active)
            await pool.execute("UPDATE enrollment_tokens SET expires_at=now() - interval '1 minute' WHERE id=$1::uuid", revoked_info["id"])
            with pytest.raises(KeyError):
                await store.revoke_enrollment_token("other-tenant", info["id"])

            hosts = await store.hosts("acme")
            assert {h["hostname"] for h in hosts} == {"web-01", "web-02"}
            await store.revoke_agent("acme", first["agent_id"], "ada")
            assert first["agent_id"] in store.snapshot.revoked_agents and first["agent_id"] not in store.snapshot.agents
            with pytest.raises(KeyError):
                await store.revoke_agent("globex", second["agent_id"], "mallory")  # Another tenant's host.
        finally:
            await pool.close()
    asyncio.run(run())


@needs_db
def test_full_gui_onboarding_journey(tmp_path):
    """Setup → platform admin → customer → invite → customer admin → token → agent enrolls → revoke."""
    issuer, ca = make_ca(tmp_path)
    settings = Settings(auth_mode="tokens", auth_file=str(tmp_path / "missing.json"), allowed_origins="https://testserver",
                        cookie_secure=True, public_grpc_address="twin.example:8443")
    origin = {"Origin": "https://testserver"}

    async def run():
        pool, store = await fresh_store()
        auth = AuthManager(settings, allow_missing_manifest=True)
        app = create_app(settings, History(), Graph(), EventHub(), audit=Audit(), identity=store, issuer=issuer,
                         setup_code="abcd-1234", auth=auth)
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as platform:
                assert (await platform.get("/api/setup")).json() == {"needed": True}
                bad = await platform.post("/api/setup", json={"code": "wrong", "username": "root.admin", "password": PASSWORD}, headers=origin)
                assert bad.status_code == 403
                assert (await platform.post("/api/setup", json={"code": "abcd-1234", "username": "root.admin",
                                                                "password": PASSWORD}, headers=origin)).status_code == 200
                assert (await platform.get("/api/setup")).json() == {"needed": False}
                login = await platform.post("/api/auth/login", json={"username": "root.admin", "password": PASSWORD}, headers=origin)
                assert login.status_code == 200 and login.json()["platform_admin"] and login.json()["tenant"] == ""
                assert (await platform.get("/api/topology")).status_code == 403  # Console has no workspace.
                created = await platform.post("/api/platform/tenants", json={"id": "acme", "name": "Acme Corp"}, headers=origin)
                assert created.status_code == 201
                invite = created.json()["invite_token"]
                listing = (await platform.get("/api/platform/tenants")).json()
                assert listing[0]["id"] == "acme" and listing[0]["pending_invites"] == 1
                assert "topology" not in str(listing)  # Health only; no customer data.

            async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as customer:
                described = await customer.post("/api/invites/describe", json={"token": invite}, headers=origin)
                assert described.json()["tenant_name"] == "Acme Corp" and described.json()["role"] == "admin"
                assert (await customer.post("/api/invites/accept", json={"token": invite, "username": "ada", "password": PASSWORD},
                                            headers=origin)).status_code == 200
                session = await customer.post("/api/auth/login", json={"username": "ada", "password": PASSWORD}, headers=origin)
                assert session.json()["tenant"] == "acme" and session.json()["role"] == "admin"
                assert (await customer.get("/api/platform/tenants")).status_code == 403
                token = (await customer.post("/api/enrollment/tokens", json={"label": "AWS lab", "max_uses": 3}, headers=origin)).json()
                assert token["token"].startswith("dtk_") and token["server_address"] == "twin.example:8443"

                # The agent installer: no session, just the token and a CSR.
                async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as agent:
                    enrolled = await agent.post("/api/enroll", json={"token": token["token"], "csr": csr_pem(), "hostname": "db01", "os": "linux"})
                    assert enrolled.status_code == 200, enrolled.text
                    body = enrolled.json()
                    cert = x509.load_pem_x509_certificate(body["certificate"].encode())
                    assert cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == body["agent_id"]
                    assert body["server_name"] == settings.grpc_server_name and "BEGIN CERTIFICATE" in body["ca_certificate"]
                    reused = await agent.post("/api/enroll", json={"token": "dtk_forged", "csr": csr_pem()})
                    assert reused.status_code == 400

                assert auth.agent_tenant(body["agent_id"]) == "acme"
                hosts = (await customer.get("/api/hosts")).json()
                assert hosts[0]["hostname"] == "db01"
                assert (await customer.post(f"/api/hosts/{body['agent_id']}/revoke", headers=origin)).status_code == 200
                assert auth.agent_tenant(body["agent_id"]) is None  # Telemetry refused immediately.

                team_invite = (await customer.post("/api/team/invites", json={"role": "viewer"}, headers=origin)).json()
                async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as viewer:
                    await viewer.post("/api/invites/accept", json={"token": team_invite["invite_token"], "username": "vic",
                                                                   "password": PASSWORD}, headers=origin)
                    await viewer.post("/api/auth/login", json={"username": "vic", "password": PASSWORD}, headers=origin)
                    assert (await viewer.get("/api/hosts")).status_code == 200
                    assert (await viewer.post("/api/enrollment/tokens", json={}, headers=origin)).status_code == 403
                    assert (await viewer.get("/api/team")).status_code == 403

                # Suspending the customer ends every session and enrollment for it.
                async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as platform:
                    relogin = await platform.post("/api/auth/login", json={"username": "root.admin", "password": PASSWORD}, headers=origin)
                    assert relogin.status_code == 200  # Still under the per-address limit of ten sign-in requests a minute.
                    assert (await platform.post("/api/platform/tenants/acme/status", json={"status": "suspended"}, headers=origin)).status_code == 200
                assert (await customer.get("/api/hosts")).status_code == 401
                # Brute-force protection: sign-in attempts beyond ten a minute from one address are refused.
                async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as attacker:
                    statuses = [(await attacker.post("/api/auth/login", json={"username": "ada", "password": PASSWORD},
                                                     headers=origin)).status_code for _ in range(3)]
                    assert statuses[0] == 401 and statuses[-1] == 429  # Suspended customer, then rate limited.
        finally:
            await pool.close()
    asyncio.run(run())
