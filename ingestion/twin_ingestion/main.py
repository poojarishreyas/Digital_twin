import asyncio
import logging
from pathlib import Path
import grpc
import uvicorn
from .api import EventHub, create_app
from .graph import GraphStore
from .postgres import HistoryStore
from .service import IngestionService, add_to_server
from .settings import Settings
from .validation import TelemetryValidator
from .phase2.store import RunStore
from .phase3.store import ResearchStore
from .audit import AuditStore
from .security import AuthManager
from .identity import IdentityStore
from .enrollment import CertificateIssuer
from .company.store import CompanyStore
from .codebases import CodebaseStore
import secrets


async def run():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings()
    # Customers and users may live entirely in the database (GUI-managed), so the
    # manifest file is optional; an existing but invalid file still fails startup.
    auth = AuthManager(settings, allow_missing_manifest=True)
    history = HistoryStore(settings.database_url)
    graph = GraphStore(settings.neo4j_uri, settings.neo4j_user, settings.neo4j_password)
    await history.open()
    await history.ensure_schema()
    audit = AuditStore(history.pool)
    await audit.ensure_schema()
    runs = RunStore(history.pool)
    await runs.ensure_schema()
    research = ResearchStore(history.pool)
    await research.ensure_schema()
    company = CompanyStore(history.pool)
    await company.ensure_schema()
    codebases = CodebaseStore(history.pool)
    await codebases.ensure_schema()
    file_manifest = auth._file_manifest() if settings.auth_mode == "tokens" else None
    identity = IdentityStore(history.pool, file_manifest.tenants if file_manifest else (), file_manifest.principals if file_manifest else ())
    await identity.ensure_schema()
    auth.directory = identity
    setup_code = None
    if settings.auth_mode == "tokens" and await identity.needs_setup(auth.manifest_has_platform_admin()):
        # Printed once to the server log: whoever can read the log owns the installation.
        setup_code = secrets.token_hex(4) + "-" + secrets.token_hex(4)
        logging.getLogger("twin.setup").warning("First-run setup required. Open the dashboard and enter setup code: %s", setup_code)
    issuer = None
    if settings.enroll_ca_cert and settings.enroll_ca_key:
        if Path(settings.enroll_ca_cert).is_file() and Path(settings.enroll_ca_key).is_file():
            issuer = CertificateIssuer(settings.enroll_ca_cert, settings.enroll_ca_key, settings.tls_ca, settings.enroll_cert_days)
        else:
            logging.getLogger("twin.enroll").warning("Agent enrollment disabled: issuing CA files not found (run deploy/pki/new-enrollment-ca)")
    await graph.open()
    events = EventHub()
    validator = TelemetryValidator(settings.schema_path)

    server = grpc.aio.server(options=[("grpc.max_receive_message_length", 16 * 1024 * 1024)])
    add_to_server(server, IngestionService(validator, history, graph, events.publish, auth.agent_tenant))
    key = Path(settings.tls_key).read_bytes()
    cert = Path(settings.tls_cert).read_bytes()
    ca = Path(settings.tls_ca).read_bytes()
    if issuer is not None and Path(settings.enroll_ca_cert).read_bytes() != ca:
        # Trust agent certificates from both the lab CA and the enrollment issuing CA.
        ca = ca.rstrip() + b"\n" + Path(settings.enroll_ca_cert).read_bytes()
    credentials = grpc.ssl_server_credentials([(key, cert)], root_certificates=ca, require_client_auth=True)
    server.add_secure_port(settings.grpc_bind, credentials)
    await server.start()

    app = create_app(settings, history, graph, events, runs, research, audit, identity, issuer, setup_code, auth, company=company, codebases=codebases)
    refresher = asyncio.create_task(identity.refresh_loop())
    web = uvicorn.Server(uvicorn.Config(app, host=settings.http_bind, port=settings.http_port,
                                      log_level="info", access_log=False, proxy_headers=False))
    try:
        await web.serve()
    finally:
        refresher.cancel()
        await server.stop(grace=10)
        await history.close()
        await graph.close()


if __name__ == "__main__":
    asyncio.run(run())

