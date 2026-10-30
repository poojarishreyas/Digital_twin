from dataclasses import dataclass, field
import os


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql://twin:change-me@localhost:5432/digital_twin")
    neo4j_uri: str = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    neo4j_user: str = os.getenv("NEO4J_USER", "neo4j")
    neo4j_password: str = os.getenv("NEO4J_PASSWORD", "change-me-now")
    grpc_bind: str = os.getenv("TWIN_GRPC_BIND", "0.0.0.0:8443")
    http_bind: str = os.getenv("TWIN_HTTP_BIND", "0.0.0.0")
    http_port: int = int(os.getenv("TWIN_HTTP_PORT", "8080"))
    tls_ca: str = os.getenv("TWIN_TLS_CA", "/certs/ca.crt")
    tls_cert: str = os.getenv("TWIN_TLS_CERT", "/certs/server.crt")
    tls_key: str = os.getenv("TWIN_TLS_KEY", "/certs/server.key")
    schema_path: str = os.getenv("TWIN_SCHEMA_PATH", "/app/schema/telemetry-v1.schema.json")
    stale_after_seconds: int = int(os.getenv("TWIN_STALE_AFTER_SECONDS", "180"))
    max_path_depth: int = min(8, int(os.getenv("TWIN_MAX_PATH_DEPTH", "8")))
    emulation_api_token: str = os.getenv("TWIN_EMULATION_API_TOKEN", "")
    auth_mode: str = field(default_factory=lambda: os.getenv("TWIN_AUTH_MODE", "tokens"))
    auth_file: str = field(default_factory=lambda: os.getenv("TWIN_AUTH_FILE", "/run/twin-secrets/auth.json"))
    deployment_mode: str = field(default_factory=lambda: os.getenv("TWIN_DEPLOYMENT_MODE", "local"))
    cookie_secure: bool = field(default_factory=lambda: os.getenv("TWIN_COOKIE_SECURE", "true").lower() == "true")
    allowed_origins: str = field(default_factory=lambda: os.getenv("TWIN_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"))
    session_seconds: int = field(default_factory=lambda: int(os.getenv("TWIN_SESSION_SECONDS", "1800")))
    request_limit_per_minute: int = field(default_factory=lambda: int(os.getenv("TWIN_REQUEST_LIMIT_PER_MINUTE", "120")))
    max_body_bytes: int = field(default_factory=lambda: int(os.getenv("TWIN_MAX_BODY_BYTES", "20000000")))
    max_run_cpu_millis: int = field(default_factory=lambda: int(os.getenv("TWIN_MAX_RUN_CPU_MILLIS", "2000")))
    max_run_ram_mb: int = field(default_factory=lambda: int(os.getenv("TWIN_MAX_RUN_RAM_MB", "4096")))
    max_pending_runs: int = field(default_factory=lambda: int(os.getenv("TWIN_MAX_PENDING_RUNS", "10")))
    # Fair-share admission: one tenant cannot occupy the whole sandbox queue.
    max_tenant_pending_runs: int = field(default_factory=lambda: int(os.getenv("TWIN_MAX_TENANT_PENDING_RUNS", "3")))
    lab_tenant: str = field(default_factory=lambda: os.getenv("TWIN_LAB_TENANT", "default"))
    # Admins of this tenant operate the platform (for example, global Prometheus metrics).
    operator_tenant: str = field(default_factory=lambda: os.getenv("TWIN_OPERATOR_TENANT", "default"))
    # Agent self-enrollment: a dedicated issuing CA signs agent client certificates.
    enroll_ca_cert: str = field(default_factory=lambda: os.getenv("TWIN_ENROLL_CA_CERT", ""))
    enroll_ca_key: str = field(default_factory=lambda: os.getenv("TWIN_ENROLL_CA_KEY", ""))
    enroll_cert_days: int = field(default_factory=lambda: int(os.getenv("TWIN_ENROLL_CERT_DAYS", "365")))
    # Address and TLS name agents use to reach gRPC ingestion (returned to enrolling agents).
    public_grpc_address: str = field(default_factory=lambda: os.getenv("TWIN_PUBLIC_GRPC_ADDRESS", "localhost:8443"))
    grpc_server_name: str = field(default_factory=lambda: os.getenv("TWIN_GRPC_SERVER_NAME", "ingestion.local"))

