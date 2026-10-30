# Company hardening verification — 2026-10-27

Target: private installation for one company. The current deliverable is a
hardened pilot foundation, **not a completed production acceptance**.

## Implemented and checked

- Per-person expiring credentials with hashed storage, browser login/logout,
  HttpOnly/Secure/SameSite cookies and immediate next-request revocation.
- API-enforced viewer/operator/admin access, allowed-origin checks for browser
  mutations, generic validation errors, request/body/session limits.
- Persistent security intent/outcome/denial audit, request IDs, no request bodies
  or credential values in access audit, fail-closed intent recording.
- CPU/RAM request ceilings, bounded queue admission serialized in PostgreSQL,
  revalidation of saved plans against current budgets before queuing.
- HTTPS company profile, private interface bindings, internal database ports,
  readiness checks, bounded container logs, restricted certificate mounts.
- Per-agent reconnect serialization in the supported single API instance,
  rejection of superseded failed receipts, sanitized ingestion error logs.
- Role-aware dashboard login, account controls and admin audit view; UI build
  completed successfully. Interactive browser visual verification was unavailable.
- Company setup, rotation, operations and recovery documentation; read-only
  preflight; cold backup and new-volume-only restore tooling.

Validation command:

```text
.venv\Scripts\python -m pytest -q ingestion\tests --basetemp .tools\pytest-company-final-1
```

Result: **79 passed**, one existing Starlette/AnyIO deprecation warning.
`npm run build` also passed. The suite includes denied API actions, CSRF,
revocation/expiry, audit outage semantics, body/rate/budget boundaries, concurrent
reconnects, and recovery refusal for active deployments, unsafe archive paths,
modified archives and existing restore targets.

## Real Docker integration that passed

Disposable project `dt-company-8ba1a6b2` ran the company HTTPS profile with real
PostgreSQL and Neo4j and verified:

- Strict TLS verification and UI security headers.
- Anonymous access denied, viewer/operator/admin role boundaries.
- Secure session cookies and cookie-mutation origin checks.
- Authenticated synthetic Windows/Linux mTLS ingestion, duplicate handling,
  configuration/port edits, removals, full reconciliation, evidence-aware paths,
  host-preserving archetypes and telemetry trust boundaries.
- Live credential rotation revoked both bearer access and browser sessions.
- Audit records persisted with actors and no token values; seeded telemetry
  secrets and access credentials were absent from checked application logs.
- Eight concurrent queue attempts admitted exactly two under capacity two.
- API restart restored readiness and retained audit history.

The runner returned `status: passed`, `cleanup: complete`; its temporary
containers and volumes were removed. This paragraph is a retained summary of
that executed run. Its original generic JSON output path was subsequently
overwritten by the failed recovery attempt below. The runner now defaults to a
unique per-run result filename to preserve future successful and failed runs.
The later stored-plan budget recheck has unit coverage; it has not been rerun
against the stopped Docker backend.

## Recovery rehearsal blocked

After extending the runner to back up both stopped databases and restore them
into a fresh project, Docker Desktop failed before the new stack could start.
The retained `research/results/company-acceptance.json` records that failed
attempt. Docker Desktop restart also failed with its WSL backend unavailable.
The C: drive had approximately 215–250 MiB free during the final checks.

Cold archive/restore safety guards are tested; **actual database recovery remains
unverified**. The expanded runner is ready to repeat after restoring Docker and
disk headroom:

```text
.venv\Scripts\python research\company_acceptance.py
```

It creates an isolated project with temporary credentials, loopback HTTPS,
synthetic telemetry and disposable databases. It does not probe production
services. It requires free localhost ports 443/8443, lab agent certificates,
OpenSSL, Docker, and enough disk space. Its cleanup removes only its own projects
and temporary database backup archives. Keep its unique JSON result.

## Outstanding before a company production rollout

See `company-deployment.md` for the operational gates. In particular: actual
Windows/Linux lab enrollment, dedicated Linux sandbox isolation, live AI
evidence, verified endpoint resolution for multi-hop topology, production PKI
revocation, least-privilege database provisioning, identity policy/SSO/MFA,
protected audit exports, image/dependency review, restore rehearsal, capacity
testing and independent security review remain open. No compliance, availability
or vulnerability-discovery guarantee is claimed.
