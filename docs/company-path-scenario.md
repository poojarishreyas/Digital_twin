# Connected company attack and repair scenario

This milestone extends the existing discovery, graph, bounded hunter and patch-verification platform with one executable company application:

`employee client -> gateway -> internal API -> PostgreSQL database`

The employee client is explicitly assumed compromised and already holds a synthetic employee credential. The scenario does not claim to reproduce or compromise a Windows laptop. All accounts and records are synthetic. The deliberately faulty application checks authentication but omits the role check on restricted records. The candidate configuration enables that check, preserving ordinary employee access and administrator access.

## Deployment and evidence

The source, original twin and candidate twin use the same exact application and database image IDs. The only intended candidate difference is the API authorization policy. Each environment has four disposable containers and three separate internal networks: employee/gateway, gateway/API and API/database. No application port is published on the host. Runtime credentials are unique per environment, stored in tmpfs, and excluded from model requests and reports.

The employee container receives only its employee credential. It has no administrator or database credentials. The gateway has no static privileged credentials, and the API's limited database account uses a different password from database administration. Administrator business-workflow probes originate in a trusted gateway context; their credentials never pass through the assumed-compromised employee client. These boundaries are checked in source, original and candidate environments.

The new optional Go-agent `workload_file` collector combines deployment provenance with a live local listener, interface addresses and established kernel sockets. It reports service/configuration/listener components through the existing mTLS ingestion path. Declaration metadata alone does not prove which code is running: the lab orchestrator separately verifies actual Docker image identities. The graph resolves an observed remote endpoint only when one enrolled workload listener uniquely matches it within the current tenant. Ambiguous mappings remain unresolved. No passive connection becomes a confirmed attack transition.

Deployment onboarding accepts a constrained `company.1` manifest, not arbitrary commands or a Compose file. The manifest records the application release, immutable image IDs, four source agent IDs, the API authorization policy and the three links. Only the company-records fixture is currently supported. A host-side worker separately checks its approved image catalog before execution. Fresh native discovery and the complete observed source path are required before admission; source configuration is checked again before execution.

TwinHunter receives the registered gateway target and three actions:

- `inspect_config`: sanitized deployment and policy information.
- `company_probe`: ordinary or restricted records using only the employee identity through the gateway.
- `company_patch`: the allowlisted authorization repair, after executed restricted access is confirmed.

Restricted access is confirmed only when the expected tenant-specific synthetic record is returned and the same request ID is correlated across gateway logs, API logs and an independently queried database access-audit row. Ports, headers, reachability and model statements alone do not confirm the path. The executor pins requests to the registered gateway address and rejects a different resolver result. There are no model-selected URLs, administrator credentials, arbitrary SQL or shell commands.

The multi-service verifier constructs a separate complete candidate. It checks original restricted access and legitimate workflows, candidate segmentation, candidate restricted access, legitimate workflows and matching image identities. Employee ordinary reads, administrator ordinary reads and administrator restricted reads must all succeed. A deny-all change therefore fails even when it blocks the attacker. Candidate resources are removed before a repair receives the verified label. Original sources are never patched.

## Run locally

Prerequisites: working Docker Engine/Desktop with sufficient free disk space, the repository Python environment, and UI dependencies. The application image build compiles the native Linux agent using the included multi-stage Dockerfile.

```powershell
$env:PYTHONPATH='ingestion;.'
npm.cmd --prefix ui run build
# Set TWIN_MODEL_API_KEY privately. Optionally set TWIN_MODEL_ENDPOINT and TWIN_MODEL_ID.
.\.venv\Scripts\python -m research.company_path_acceptance --keep
```

The runner builds application images and API, starts an isolated control plane, provisions sources for `acme` and `globex`, starts eight native agents with individual mTLS certificates, waits for discovery, imports each deployment, checks graph paths, and queues jobs. A host-side worker calls the configured live model and performs attack/repair/retest on disposable copies.

Acceptance also checks foreign run/artifact access, simultaneous tenant networks, foreign credentials and tool targets, tenant-specific evidence, ineffective and workflow-breaking controls, and unchanged sources. The default model condition is live Gemini. Explicit `--scripted` produces a separately labeled non-AI integration smoke; no scripted substitute is used silently. `--no-build` supports focused reruns using already built images.

`--keep` retains synthetic sources and the control plane for review. Application verification copies are still removed. Open `http://localhost:3001/#company`; a private access-token file is retained under `.tools/<project>/access.json`. Do not share it or commit `.tools`. The API uses loopback port 8090, gRPC 18443, and PostgreSQL/Neo4j worker access 15432/17687. Generated Compose configuration and credentials stay outside Git.

Without `--keep`, source resources and temporary control-plane databases are removed at exit. JSON reports and hash-chained traces remain under `research/results/`. To stop a retained project, run `python -m research.company_path_acceptance --cleanup <acceptance-report.json>`. This verifies the recorded tenant/job labels, removes only those source containers and networks, and stops that exact generated Compose project. Do not use broad Docker prune commands for cleanup.

`--release-sources <acceptance-report.json>` removes just the recorded synthetic sources while keeping the dashboard and database history for review. Those source agents then become stale, as expected; a subsequent new acceptance deployment is needed for fresh source discovery.

An unchanged retained deployment can supply source discovery for a new model condition with `--reuse <acceptance-report.json> --keep`. Reuse requires a passed report or verified native discovery and employee credential boundaries for both companies; superseded fixtures are refused. Its fresh runs and traces are stored separately, with explicit references to passed deterministic boundary controls. Missing boundary controls are executed before success. `--tenants globex` retries only that company's run; earlier failures remain visible. The retained helper reduces the rapid discovery-test cadence to normal 30-second collection intervals.

For a locally compiled Linux agent, pass `--agent-binary <linux-amd64-agent>` to build using a dedicated binary-only Docker context. The runner records its SHA-256. The standard multi-stage Go build remains the default. No prebuilt agent or private credentials are committed.

## Existing deployment

API startup initializes tenant-scoped company artifact and run tables in the existing PostgreSQL history database. The API has no Docker socket. Operators import manifests and queue jobs through **Company validation**; viewers read their own results. The host worker runs separately:

```powershell
# Set DATABASE_URL, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD and model configuration privately.
$env:PYTHONPATH='ingestion'
.\.venv\Scripts\python -m twin_ingestion.company.worker --catalog <approved-image-catalog.json>
```

The catalog has immutable `node_image` and `database_image` `sha256:` IDs. Only images already built and approved on that worker can execute. This is not a general customer-image execution service. Existing Phase 2 runs, Phase 3 reports, MCP tools and the paper benchmark remain separate and retain their historical scopes.

## Verification scope

The lab measures synthetic application behavior, dependency reconstruction, role semantics and Docker network segmentation. It does not certify dedicated Linux host/LAN/internet firewall acceptance, initial endpoint compromise, production repair deployment, Windows desktop fidelity, arbitrary application support or general vulnerability-discovery quality. These limitations appear in the dashboard and results.

```powershell
.\.venv\Scripts\python -m pytest -q --basetemp .tools/pytest-company-path ingestion/tests
.\.tools\go\bin\go.exe -C agent test ./...
npm.cmd --prefix ui run build
```

Company hunts allow eight model steps, 65,536 reserved tokens, a 360-second decision-loop budget and a 60-second maximum model response wait. They stop when the trusted executor has verified and cleaned up a valid repair; an additional model closing statement is unnecessary. The original and candidate bundles together have hard container ceilings of 1900m CPU and 2176 MB RAM; admission refuses lower configured server budgets. Existing service benchmarks retain their original default model response wait. The integration report, rather than the existence of the runner, determines which checks passed in an execution.

## Recorded milestone

[The milestone summary](../research/results/company-path-milestone.json) combines completed live Gemini runs for Acme (`cc9922cc-8882-4c59-b54d-92effaeed2aa`) and Globex (`28d0024c-8b46-432b-90f3-7aab2a122a8b`). Both show employee restricted access changing from HTTP 200 to HTTP 403 in the candidate, three passing legitimate workflows, identical application images, verified trace chains and cleaned-up verification copies. Independent controls rejected ineffective and business-breaking repairs and denied cross-tenant networks, credentials, tools and results. Final checks confirmed unchanged sources and tenant cookie access through the dashboard server. Browser visual review could not complete because computer-use approval timed out.

The source/control-plane project is `company-path-e7f65303f6`. Its private sign-in tokens are in `.tools/company-path-e7f65303f6/access.json`; choose the relevant tenant token in the dashboard's token sign-in. Select the completed run above on **Company validation**. Earlier failed runs remain visible. To stop this retained fixture:

```powershell
$env:PYTHONPATH='ingestion;.'
.\.venv\Scripts\python -m research.company_path_acceptance --cleanup research/results/company-path-e7f65303f6.json
```
