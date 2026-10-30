# Private single-company deployment

This repository now provides an authenticated **single-company pilot**, with a
tested HTTPS control plane. It is not a certified enterprise product. Do not put
company assets under active testing until the dedicated Linux isolation and
operational acceptance gates below have passed.

## Supported deployment shape

Run one ingestion/API instance and one sandbox worker. Browser traffic enters a
private HTTPS gateway. PostgreSQL and Neo4j have no published ports in the company
profile. Agents use port 8443 with individual CA-signed client certificates;
restrict this port to enrolled hosts over a private network/VPN. The dedicated
Linux sandbox is separate from the control plane and source hosts. Do not give
test workloads Docker socket access or production credentials.

This is a single-instance design, not multi-tenant SaaS or high availability.
Browser sessions and rate limits are process-local. A restart signs browser users
out. Per-agent synchronization locks prevent overlapping reconnects within this
instance; do not scale ingestion replicas without distributed sequencing and
cross-store recovery changes. PostgreSQL and Neo4j writes are not one distributed
transaction; full snapshots reconcile interrupted writes.

## Access model

| Role | Permissions |
|---|---|
| Viewer | Inventory, topology, paths, metrics, run and research evidence |
| Operator | Viewer access plus asset classifications, plans, queued runs, report import |
| Admin | Operator access plus security audit history |

Credential issuance and revocation require OS administrator access, not an HTTP
endpoint. Each person gets a different random credential. Only its SHA-256 hash
and expiry are mounted into ingestion. The browser exchanges it for a Secure,
HttpOnly, SameSite=Strict cookie with a 30-minute absolute lifetime. Credentials
are never placed in localStorage, URLs, or API audit bodies. CLI clients use
`Authorization: Bearer <individual credential>`. Do not paste credentials into
chat, scripts, screenshots or command history.

Company mode rejects anonymous lab mode, insecure cookies, non-HTTPS browser
origins and the old default database passwords. Role checks run on the API;
hiding a button is only a UI convenience. The legacy `X-Emulation-Token` does not
grant access in authenticated mode. `/healthz` and `/readyz` return public,
minimal status; `/metrics` requires viewer credentials. Limits include request
body size, per-principal request rate, login attempts, session capacity, run
CPU/RAM budgets and a transactionally bounded queue.

## First setup

Use a private Linux server, Docker Engine/Compose 2.24.4 or later, Python 3.13 for
operator scripts, and sufficient storage. Review pinned release images with your
organization before deployment; the development control-plane image tags are
not a signed, vulnerability-reviewed release bundle.

1. Copy `.env.example` to `.env`. Generate independent random hexadecimal
   database passwords (at least 24 random bytes each). Keep `.env` in a vault or
   access-restricted directory. Never commit it. Existing database volumes keep
   their previous passwords: changing an environment value alone does not rotate
   a database login.
2. Issue individual access credentials from the repository root:

   ```text
   python deploy/auth/create_principal.py --id alice --role admin
   python deploy/auth/create_principal.py --id analyst --role operator
   python deploy/auth/create_principal.py --id reviewer --role viewer
   ```

   The manifest is `secrets/auth/auth.json`. Plain credentials are written to
   `secrets/credentials/<id>.token`, outside the mounted manifest directory.
   Files are created with mode 0600 on POSIX. On Windows, restrict the `secrets`
   directory ACL to the operator and required service account. Distribute each
   credential privately, then remove the delivery copy after vaulting it.
3. Obtain an HTTPS certificate for the private browser hostname. Put its chain
   at `secrets/tls/fullchain.pem` and key at `secrets/tls/privkey.pem`. Clients must
   trust the issuing CA. Do not disable certificate verification. Use a managed
   internal PKI for agent enrollment and renewal; lab PKI scripts are for demos.
   Ingestion mounts only its CA certificate and server certificate/key, not the
   CA signing key or agent private keys.
4. Add private interface addresses and the exact browser origin to `.env`:

   ```text
   TWIN_AGENT_BIND=10.0.1.10
   TWIN_WEB_BIND=10.0.1.10
   TWIN_PUBLIC_ORIGIN=https://twin.internal.example
   ```

   Replace these examples with the server's real private address and hostname.
   Restrict inbound 443 to authorized staff/VPN and 8443 to agent hosts. Do not
   publish database ports or the unauthenticated internal HTTP hop.
5. Validate without printing resolved secrets, then start:

   ```text
   python deploy/company/preflight.py
   docker compose -p company-twin -f docker-compose.yml -f deploy/company/compose.yml config --quiet
   docker compose -p company-twin -f docker-compose.yml -f deploy/company/compose.yml up -d --build --wait
   ```

   Open the HTTPS hostname and sign in with the individual credential. Local
   laptop demos may use the base Compose file on localhost:3000; its HTTP cookie
   setting is deliberately overridden in company mode.

The preflight is read-only and reports missing configuration without printing
resolved secrets. Run it with this repository's Python dependencies installed.
It does not replace certificate validity/trust checks or an isolation assessment.

## Rotation and incidents

Rotate a principal with the same command plus `--rotate`. This changes the token
hash and invalidates their existing sessions on their next request. Remove the
principal from the manifest to revoke access; retain at least one valid admin.
Update the manifest atomically inside its mounted directory. Invalid manifest
contents fail authentication and readiness closed. SSE streams recheck access
on updates and at most every 15 seconds while idle.

In a suspected credential incident, revoke the principal, preserve the audit
trail, correlate `X-Request-ID`, rotate affected credentials, and review actions.
Intent is persisted before an API operation. If recording the outcome fails,
the API returns 503 with an explicit reconciliation warning: a mutation may
have occurred, so inspect state before retrying. Audit records omit bodies,
query strings and tokens. They record actor, role, action category, stage,
timestamp, status and request ID. They are **not tamper-proof** against a database
administrator, and do not yet constitute a full resource-level change journal.
Export them to independently protected company logging storage.

Agent certificate identity is bound to its host namespace. There is not yet an
application-level enrollment revocation list/CRL workflow; emergency revocation
requires network blocking and PKI action. Complete this operational integration
before enrolling production hosts.

## Backup and recovery

The supplied tool creates a coordinated cold backup of both stores and restores
only into **new volumes**. It refuses active projects, unclean database exits,
foreign volumes, checksum mismatches, archive traversal/links/devices and an
existing recovery target. It does not stop services or overwrite a deployment.
Use encrypted backup storage with a retention policy. The archives contain
sensitive topology, history and database credential material; a checksum detects
corruption but is not an authenticity signature. Keep recovery secrets, TLS keys,
image IDs and release artifacts separately in your company vault.

Schedule a maintenance window, stop the external sandbox worker and wait for
cleanup/reconciliation, then stop this project's containers:

```text
docker compose -p company-twin -f docker-compose.yml -f deploy/company/compose.yml stop -t 30
python deploy/ops/cold_backup.py archive --project company-twin --destination backups/2026-10-27 --external-workers-stopped
docker compose -p company-twin -f docker-compose.yml -f deploy/company/compose.yml start
```

Restore on an isolated recovery host with the same database image versions and
architecture, original database credentials, auth manifest and valid TLS keys:

```text
python deploy/ops/cold_backup.py restore --source backups/2026-10-27 --new-project company-recovery
docker compose -p company-recovery -f docker-compose.yml -f deploy/company/compose.yml up -d --wait
```

The helper image ID recorded in the manifest must already be available; retain
the images with the release. Use separate private interfaces/ports if rehearsing
on the original host. Verify `/readyz`, inventory, asset/edge counts, sequences,
run evidence and audit history before switching traffic. Recover/reconcile the
worker separately; never start two workers with the same identity. Expect agent
full snapshots after recovery. Record measured RPO/RTO; no recovery SLA has been
established by this repository.

## Operations and acceptance gates

Monitor `/readyz`, authenticated `/metrics`, stale agents, reconciliation gaps,
queue depth, failed cleanup, certificate expiry and disk space. An unhealthy
Compose status is an alert signal, not automatic repair. Rotate logs, archive
history under an agreed retention policy and keep enough disk space for both
database growth and backups. Database retention automation and notification
integrations still need deployment-specific work.

Before production onboarding, finish these gates:

- Native Windows and Linux service enrollment and collection-permission review.
- Dedicated Linux sandbox allowed/denied host, LAN and internet positive-control
  checks, resource measurements, interrupted cleanup and live TwinHunter runs.
- Backup/restore rehearsal on the actual deployment, off-host encrypted copies,
  documented RPO/RTO, and a recovery owner.
- Least-privilege database/service accounts and separate migration ownership.
  The current Compose bootstrap still uses database owner credentials; it is not
  a least-privilege production database provisioning system.
- Company identity/SSO/MFA policy, agent revocation lifecycle, independently
  protected audit exports, incident response and retention requirements.
- Dependency/image vulnerability review, signed release artifacts, an independent
  security assessment and representative capacity/load tests.

Observed connections and bounded candidate paths are not proof of exploitability.
Endpoint-to-enrolled-host resolution still needs verified mappings for real
multi-hop coverage. Do not interpret a missing path or failed probe as proof of
security. See `docs/mini-lab-blueprint.md` and the measured acceptance reports.
