# Digital Twin — Discovery, Emulation and Bounded Hunting

Multi-tenant platform for passive Windows/Linux discovery, durable delta synchronization, a Neo4j topology twin, PostgreSQL run history, sandboxed emulation, bounded AI hunting, and a 3D web console.

## Architecture

```text
Windows/Linux agent
  collectors -> sanitizer -> canonical hashes -> disk outbox
       |                 gRPC + mutual TLS
       +------------------------------------> ingestion
                                               |-> schema validation
                                               |-> PostgreSQL runs/metrics/dedup
                                               |-> Neo4j assets/evidence/topology
                                               +-> REST/SSE -> React UI
```

Relationship semantics are intentionally separate: `OBSERVED_CONNECTION` is evidence of a connection, `INFERRED_REACHABILITY` is a bounded model inference, and `CONFIRMED_ATTACK_TRANSITION` requires an external confirmation source that Phase 1 does not create.

## Local lab quick start

Prerequisites: Docker Compose, OpenSSL, Go 1.23+ for agent builds, and Node 22+ for local UI development.

1. Copy `.env.example` to `.env` and change both passwords.
2. Generate lab certificates: `pwsh deploy/pki/new-lab-pki.ps1` (Windows) or `bash deploy/pki/new-lab-pki.sh` (Linux). The scripts create distinct `agent` and `agent-linux` client certificates and IDs. Keep their private keys on the respective lab hosts.
3. Create the agent enrollment CA once: `bash deploy/pki/new-enrollment-ca.sh` (or `pwsh deploy/pki/new-enrollment-ca.ps1`). Create an empty `secrets/auth` folder, then start storage, ingestion and UI: `docker compose up --build`. Open the dashboard; on first run it asks for the one-time setup code printed in the ingestion log (`docker compose logs ingestion | grep "setup code"`) and creates the platform admin. Everything after that happens in the browser (see *Onboarding without the command line* below).
4. Use the supplied `bin/` artifacts or build an agent: `go build -C agent -o ../bin/twin-agent ./cmd/twin-agent` (add `.exe` on Windows). After copying the Linux artifact, run `chmod 0755 twin-agent-linux-amd64`.
5. Machines normally join with the one-line command from **Hosts → Add hosts**. For manual lab certificates instead, register each identity (`certs/*.id`) with `python deploy/auth/tenants.py register-agent <id> --tenant <tenant>`; unregistered agents are refused.
6. Manual alternative: copy `deploy/agent.example.yaml` to each host and use absolute CA and client certificate paths. Use `agent.crt`/`agent.key` on the Windows lab host and `agent-linux.crt`/`agent-linux.key` on the Linux lab host. Set `server_address` to the ingestion host, then run the appropriate `bin/twin-agent -config <path>`.

The client certificate common name is the stable agent ID. The agent persists it in its state directory and rejects a later certificate with a different ID; renew certificates with the same common name for an existing enrollment. Re-running the lab PKI script creates a new CA and new identities, so it requires fresh lab enrollment.

The UI is at <http://localhost:3000>, REST health at <http://localhost:8080/healthz>, and ingestion gRPC at `localhost:8443`.

For a private company pilot, use the [company deployment and recovery guide](docs/company-deployment.md).
It includes HTTPS ingress, individual roles, access audit, credential rotation and explicit production acceptance gates.
The base Compose file publishes only on loopback; remote agents require an explicitly configured private interface.

## Onboarding without the command line

1. **Platform admin** (first-run setup page) opens **Platform console → New customer**, enters a company name, and sends the generated invite link to the customer's administrator. The console shows each customer's health and usage only — never their topology, paths or findings.
2. **Customer admin** opens the link, creates an account, and lands in their own workspace.
3. **Hosts → Add hosts** generates a short-lived install command (one machine, or up to 1,000 for a fleet). Paste it on each server:
   - Linux: `curl -fsSL https://PLATFORM/agent/install.sh | sudo bash -s -- --url https://PLATFORM --token dtk_...`
   - Windows (elevated PowerShell): `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://PLATFORM/agent/install.ps1).Content)) -Url https://PLATFORM -Token dtk_...`
   - Whole fleet: put the Linux line in cloud *user data* or an Ansible/Intune/SCCM job.
4. The installer downloads the agent, verifies its SHA-256, generates a private key that never leaves the machine, exchanges the token for a client certificate bound to that workspace (`POST /api/enroll`), and installs an auto-restarting service. The machine appears in the 3D twin within seconds and stays live.
5. The Overview suggests entry points and crown jewels from the discovered twin; one click applies them and candidate attack paths appear. **Team** invites colleagues as viewer, operator or admin; **Hosts → Remove** cuts a machine off immediately.

Customers, users, memberships, invites, enrollment tokens and enrolled agents live in PostgreSQL (`twin_ingestion/identity.py`); passwords use scrypt and every token is stored only as a hash. The manifest file remains supported for file-managed tenants and CLI credentials. Publish the platform over HTTPS; the installers refuse plain HTTP to non-loopback hosts unless `--allow-http` is given for an isolated lab.

## Multi-tenancy

One control plane serves many isolated workspaces (tenants). Isolation is enforced server-side on every request:

| Layer | Mechanism |
|---|---|
| Identity | `secrets/auth/auth.json` (version 2) lists tenants, principals with per-tenant roles, and an agent → tenant registry. It is re-read on every request, so revocation and suspension take effect immediately. |
| Sessions | A browser session is bound to one tenant. `POST /api/auth/tenant` re-authorizes and rotates the session; an `X-Tenant` header can never move a cookie session. Bearer clients pick a membership with `X-Tenant`. |
| Telemetry | The agent's certificate common name resolves to exactly one active tenant; unknown agents and suspended tenants are rejected before storage. |
| Graph | Every Neo4j node has a unique `key` = `<tenant>|<id>`. Shared endpoints (for example the same remote IP seen by two customers) become separate nodes, and archetypes are per tenant. |
| History | All PostgreSQL tables carry `tenant_id` in their keys and every query filters by it. Existing single-company databases are migrated in place to the `default` tenant at startup. |
| Events, audit | Server-sent events are partitioned per tenant; admins read only their tenant's audit rows. `/metrics` is limited to admins of `TWIN_OPERATOR_TENANT`. |
| Sandbox | Plans and runs are tenant-owned; twins run on per-run internal networks labeled `digital-twin.tenant`. `TWIN_MAX_TENANT_PENDING_RUNS` caps each tenant's share of the queue. |

Manage tenants with `deploy/auth/tenants.py` (`create-tenant`, `grant`, `revoke`, `register-agent`, `suspend`, `list`). A version 1 manifest still works as a single `default` tenant and is upgraded in place by the first `tenants.py` command; the upgrade keeps unregistered agents reporting to `default` until you run `set-agent-fallback --none`. `ingestion/tests/test_tenancy.py` covers the isolation guarantees.

## Web console

The React console (light theme) includes a live three.js twin. Hosts are laid out by reachability from entry points: perimeter, internal, then crown jewels. It also provides attack-path replay with isolation "shield" what-ifs, sandbox emulation replay (clone → probe → verdict → teardown), TwinHunter research insights, a workspace switcher, and per-tenant audit. Replays visualize recorded or candidate data; they do not validate exploitability.

To preview the console without the backend, run `VITE_DEMO=1 npm run dev` in `ui/`. Demo mode is development-only, uses clearly labeled synthetic workspaces, and is excluded from production builds.

## Agent service installation

Linux (systemd, as root):

```bash
sudo deploy/service/install-linux.sh /absolute/path/to/twin-agent /etc/twin-agent/config.yaml
```

Windows (elevated PowerShell):

```powershell
deploy/service/install-windows.ps1 -Binary C:\TwinAgent\twin-agent.exe -Config C:\TwinAgent\config.yaml
```

Both installers create a service with automatic restart. `SIGTERM`, Ctrl+C, and Windows service stop use the same graceful shutdown path; the durable outbox remains for replay.

## Asset declarations and candidate paths

Mark assets through the REST API:

```bash
curl -X PUT http://localhost:8080/api/assets/HOST_ID/classification \
  -H "Authorization: Bearer $TWIN_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"entry":true,"critical":false}'
curl -H "Authorization: Bearer $TWIN_API_TOKEN" 'http://localhost:8080/api/paths?max_depth=4'
```

Only observed and inferred edges participate. Confirmed attack transitions are displayed if imported by a future authorized phase, but are never fabricated from socket telemetry.

## Verification

```bash
python -m pip install -r ingestion/requirements-dev.txt
pytest ingestion/tests
go test ./...              # from agent/ with Go installed
npm ci && npm run build    # from ui/
```

This workstation does not need access to production systems. Use only lab-generated certificates and synthetic credentials/data.

## Phase 2

The selective emulation planner, service adapters, Linux sandbox worker, deterministic probes, evidence storage, fixed lab fixtures, and dashboard run view are in `ingestion/twin_ingestion/phase2`, `emulation`, and `ui/src/runView.tsx`. Deployment and runtime acceptance instructions are in [docs/phase2.md](docs/phase2.md). The worker runs on a dedicated Linux lab host; it is not part of the Compose application containers.

On Windows with Docker Desktop, set `$env:PYTHONPATH='ingestion'` in PowerShell and run `.\.venv\Scripts\python emulation\desktop_smoke.py --repetitions 2 --scan`. This exercises service behavior and scans, while the host firewall isolation gate remains on the dedicated Linux worker.

## Phase 3

TwinHunter, typed tool enforcement, disposable patch verification, research history and dashboard traces are implemented in `ingestion/twin_ingestion/phase3`. The 20-scenario benchmark, independent wire oracle, scheduling comparison, raw results, plots and manuscript draft are under `research/`. See [docs/phase3.md](docs/phase3.md) for exact commands and GPU deployment. The current Colab A100 profile pins Qwen3.8-27B and is unvalidated until a live GPU run completes; historical reports retain their original model locks and missing AI results remain unavailable.

For a free GPU smoke check when an A100 is unavailable, use the separate [Kaggle T4 notebook](deploy/models/kaggle-free-t4-setup.ipynb) with Qwen3.5-4B FP16. Its result is a distinct small-model condition, not the 27B benchmark.

TwinHunter's primary model is **Gemini 3.8 Flash**, reached through the OmniRoute `lynx-harness` gateway (`deploy/models/model-gemini.json`). Decisions returned by any other upstream model are refused as model errors so they cannot mix into the Gemini condition. The pinned local Qwen profile remains available with `TWIN_MODEL_BACKEND=local`. See [the model setup](docs/phase3.md#primary-model-gemini-38-flash-via-omniroute) for environment variables.

Open `research/results/repeated/report.json` in the dashboard's Phase 3 panel to view the measured local results. [research/PROTOCOL.md](research/PROTOCOL.md) defines the baselines and denominators, and [research/manuscript.md](research/manuscript.md) states the current evidence and limitations.

