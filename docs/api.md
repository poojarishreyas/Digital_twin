# Ingestion and read API

## Telemetry ingestion

- Transport: gRPC over TLS with a server certificate and required CA-signed client certificate.
- Method: unary `twin.telemetry.v1.TelemetryIngest/Sync`.
- gRPC content subtype: `json`.
- Request: an envelope conforming to `schema/telemetry-v1.schema.json`.
- Maximum request: 16 MiB.

The authenticated certificate common name must equal `agent_id` and `host.id`. Component IDs use the agent's namespace: `<kind>:<agent_id>[:local-id]`, with `config` as the prefix for configuration records. Removals and structural relationship targets must remain in that namespace, and relationship sources must be the enrolled host. A client certificate does not authorize writes to another host's components.

The passive telemetry schema accepts observed/inferred evidence only. Agents cannot submit `CONFIRMED_ATTACK_TRANSITION` edges or confirmed component evidence. Confirmed test results retain their separate run/evidence provenance. Invalid telemetry receives a generic rejection; raw validation exceptions and field values are not echoed into logs or acknowledgements.

Response:

```json
{
  "accepted_sequence": 42,
  "duplicate": false,
  "require_full_snapshot": false,
  "error": ""
}
```

An accepted or duplicate sequence can be removed from the agent outbox. `require_full_snapshot` makes the next collection a reconciliation snapshot. A non-empty `error` is retryable unless an operator determines the schema/client is invalid. The server never logs the raw request.

## Tenancy

Every authenticated request runs in exactly one tenant. Data endpoints return only that tenant's records; an ID that belongs to another tenant (asset, plan, run or report) behaves exactly like a missing one (404).

- Browser: `POST /api/auth/login` accepts an optional `{"tenant": "acme"}`; otherwise the first active membership (sorted by ID) is used. `POST /api/auth/tenant` with `{"tenant": "..."}` switches workspace and rotates the session cookie. The session response lists `tenant` and every active membership in `tenants`.
- CLI: send `X-Tenant: <id>` with the bearer credential. Without it, the first active membership is used.
- Roles are per tenant: a principal can be admin in one workspace and viewer in another.
- `GET /api/tenant` returns the workspace name, status, quotas and isolation summary.
- Telemetry: the gRPC client certificate common name must be registered to an active tenant (or the manifest must name a `default_agent_tenant` fallback). Otherwise the acknowledgement carries `error: "agent is not enrolled in an active tenant"`.

## Onboarding and administration API

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET`/`POST` | `/api/setup` | public (setup code) | First-run status; create the first platform admin |
| `POST` | `/api/auth/login` | public | `{username, password}` or `{token}`; optional `tenant` |
| `POST` | `/api/invites/describe`, `/api/invites/accept` | public (invite token) | Show and accept an invite; creates the account or adds a membership |
| `POST` | `/api/account/password` | signed in | Change your password (ends other sessions) |
| `GET`/`POST` | `/api/platform/tenants` | platform admin | Customer health list; create a customer and its first admin invite |
| `POST` | `/api/platform/tenants/{id}/status`, `/api/platform/tenants/{id}/invites`, `/api/platform/admins/invites` | platform admin | Suspend/reactivate; re-invite; invite another platform admin |
| `GET` | `/api/team`; `POST /api/team/invites`; `PUT`/`DELETE /api/team/members/{id}`; `DELETE /api/team/invites/{id}` | workspace admin | Members, invites and roles (a workspace always keeps one admin) |
| `GET`/`POST` | `/api/enrollment/tokens`; `POST /api/enrollment/tokens/{id}/revoke` | workspace admin | Short-lived, use-limited install tokens |
| `GET` | `/api/hosts`; `POST /api/hosts/{agent_id}/revoke` | viewer; admin | Enrolled machines; revoke one (its telemetry is refused immediately) |
| `POST` | `/api/enroll` | public (enrollment token) | `{token, csr, hostname, os}` → client certificate whose common name is a server-chosen agent ID, plus CA, gRPC address and TLS name |

Public routes are rate limited per address (sign-in, setup and invite routes at ten a minute) and recorded in the access audit. A platform admin without a workspace reaches only platform routes; workspace routes return 403 until a workspace is selected. Enrollment requires the issuing CA (`TWIN_ENROLL_CA_CERT`, `TWIN_ENROLL_CA_KEY`); the gRPC server then trusts agent certificates from it alongside the lab CA.

## Read API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Process health |
| `GET` | `/metrics` | Prometheus ingestion counters/latencies |
| `GET` | `/api/inventory` | Agent sequence, last-seen, stale/reconciliation state, and gaps |
| `GET` | `/api/topology` | Current graph nodes and evidence edges |
| `GET` | `/api/measurements?limit=200` | Collection/synchronization measurements |
| `PUT` | `/api/assets/{id}/classification` | Declare `{entry, critical}` for lab path analysis |
| `GET` | `/api/paths?max_depth=4` | Bounded candidate paths, evidence quality, declared universe, review points |
| `GET` | `/api/paths?max_depth=4&isolated_asset=ID` | Read-only isolation preview over the returned candidates |
| `GET` | `/api/events` | Server-sent graph update events for the session's tenant |
| `GET` | `/api/tenant` | Current workspace, quotas and isolation summary |
| `POST` | `/api/auth/tenant` | Switch the browser session to another membership |
| `GET` | `/api/research/reports/{id}` | Stored report with `summary` and `insights` |
| `POST` | `/api/research/insights` | Read-only summary and insights for an unsaved report (viewer) |

All data endpoints require an individual bearer credential or browser session.
Viewer access is read-only; operators can classify assets, create plans, enqueue
runs and import reports. Only admins can read `/api/admin/audit`. Browser login is
`POST /api/auth/login` with `{ "token": "..." }`; session status and logout use
`GET /api/auth/session` and `POST /api/auth/logout`. Cookies are HttpOnly,
SameSite=Strict and Secure in company mode. Cookie-authenticated writes require
an exact allowed Origin. CLI bearer requests do not require an Origin header.
`GET /readyz` checks database connectivity, audit storage and authentication
configuration; it returns a minimal 503 when unavailable. `/healthz` is liveness.
Both health endpoints are public. See `company-deployment.md` for setup and limits.

Intent and outcome audit records carry a request ID returned as `X-Request-ID`.
An audit intent failure prevents execution. An outcome persistence failure may
follow a completed mutation: reconcile state before retrying. Request bodies,
query strings and credentials are omitted from access audit records.

## Candidate path evidence and isolation previews

The `paths` array remains compatible with the original read API. `assessments` adds stable path IDs, ordered hop evidence, a review order, telemetry issues, and the next validation action. Every result has `validation_status: unvalidated`. Current telemetry is not proof of exploitability. Stale, future-dated, unknown, or semantically inconsistent evidence, missing provenance, stale agents, reconciliation requirements, collection gaps, and unresolved assets are reported explicitly.

`universe` declares entry/critical endpoints, hop/path/traversal limits, excluded edge counts, generation time, freshness threshold, assumptions, and truncation flags. Enumeration is directed, deterministic, deduplicated, and bounded to 500 paths and 10,000 queued traversal states in total. Structural/archetype edges and confirmed transitions do not become candidate connectivity edges. No result is interpreted as proof that no attack route exists.

`review_points` ranks intermediate assets by the number of returned paths that traverse them. It is a review aid, not an exploit probability or a minimum-cut calculation. Paths are ordered by fewer hops, then fewer telemetry issues. `isolated_asset` simulates removing all traversals through one existing asset; `isolation_preview` reports affected and remaining returned paths. No graph, network, or configuration is changed. With truncated input or traversal, these counts apply only to the returned subset. Real segmentation must be tested for both security and legitimate workflows.

In the dashboard, select an asset and save its entry/critical roles in Evidence detail. The Candidate paths panel offers hop limits, evidence inspection, shared-asset review, and isolation previews. End-to-end twin validation remains in the run evidence view.
