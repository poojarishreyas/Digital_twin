# Phase 2 lab deployment and validation

## Placement

Run the Compose stack and the Phase 2 worker on a dedicated Linux lab host. The worker is a host service with access to Docker and `iptables`; the React app, ingestion container, service twins, and probe workloads have no Docker socket. Use a separate lab host from enrolled production systems. Docker internal networks and host firewall rules are both required; neither alone is an air-gap guarantee.

The application API accepts emulation plan/run mutations only when `TWIN_EMULATION_API_TOKEN` is set and provided as `X-Emulation-Token`. Keep port 8080 behind a lab ingress. The worker reads PostgreSQL through the loopback mapping; it does not expose Docker control through the API.

## Prepare images

On the Linux lab host, install Docker Engine/Compose, `iptables`, Python 3.13, and OpenSSL. Use linux/amd64. Build the two local images and pre-pull the three service images:

```bash
docker pull nginx@sha256:62223d644fa234c3a1cc785ee14242ec47a77364226f1c811d2f669f96dc2ac8
docker pull postgres@sha256:5d706d5aa3ad311722f373fdc09e6a22b454bec70d34d9786383983fd83c5e46
docker pull redis@sha256:519f0189dfdee3bc0bad61fb265fe73d864b5c64020e6579ad48a45c49965635
docker build -t twin-openssh:9.9p2-local emulation/images/openssh
docker build -t twin-probe:phase2-local emulation/images/probe
```

OpenSSH uses a pinned Alpine base and exact `openssh-server=9.9_p2-r0` package. The probe image verifies the [official Nuclei 3.11.1 archive SHA-256](https://github.com/projectdiscovery/nuclei/releases/expanded_assets/v3.11.1) before installing its binary, and pins `nmap=7.95-r1`. The worker records the actual local image ID in each finding. If an image or package is unavailable, preparation fails visibly; do not replace it with `latest`.

## Start the stack and worker

1. Set database passwords and a long random `TWIN_EMULATION_API_TOKEN` in `.env`.
2. Generate lab mTLS certificates, then run `docker compose up --build -d`.
3. Create a Python 3.13 virtual environment on the Linux host and install `ingestion/requirements.txt`.
4. Make `/etc/twin-emulation/destinations.json` from `emulation/destinations.example.json`. Replace every example address with an operator-controlled TCP listener reachable from the Linux host, including one designated host, one LAN, and one internet test endpoint. The worker requires all three positive controls to connect successfully before it tests sandbox denials.
5. Create `/etc/twin-emulation/worker.env` with `TWIN_EMULATION_DATABASE_URL=postgresql://twin:<password>@127.0.0.1:5432/digital_twin` and `TWIN_EMULATION_DESTINATIONS_FILE=/etc/twin-emulation/destinations.json`. Keep it readable only by root.
6. Place this repository at `/opt/digital-twin`, install `deploy/service/twin-emulation-worker.service` under `/etc/systemd/system`, and enable/start it with systemd.

The worker must run on a dedicated Linux host as root so it can install scoped `INPUT` and `DOCKER-USER` rules for the per-run bridges. It reconciles its labeled containers, networks, and rules when restarted. Do not grant Docker or network administration capabilities to testing containers.

## Plan and queue

Classify entry and critical assets in the Phase 1 graph first. Then:

```bash
curl -sS -X POST http://localhost:8080/api/emulation/plans \
  -H 'content-type: application/json' -H 'X-Emulation-Token: <token>' \
  -d '{"max_hops":4,"cpu_budget_millis":2000,"ram_budget_mb":4096}'
curl -sS -X POST http://localhost:8080/api/emulation/runs \
  -H 'content-type: application/json' -H 'X-Emulation-Token: <token>' \
  -d '{"plan_id":"<id from previous response>"}'
```

The plan reports universe size, planned and untested paths, excluded state, truncation, wave service bundles, and resource estimates. `GET /api/emulation/runs/{id}` distinguishes planned paths from those with confirmed end-to-end chain evidence.

## Fixed acceptance fixtures

Run the eight secure/vulnerable fixtures and a two-service Nginx chain twice:

```bash
PYTHONPATH=ingestion .venv/bin/python emulation/lab_acceptance.py \
  --destinations /etc/twin-emulation/destinations.json --repetitions 2
```

The harness returns nonzero if readiness, intended allowed/denied paths, expected verdicts, cleanup, or sampled resource limits fail. Retain the JSON output, Docker Engine version, host hardware, and image IDs with the lab record. This is the runtime acceptance gate; unit tests only validate planning and rendered configuration syntax/intent.

## Docker Desktop smoke check

Windows Docker Desktop can exercise the service renderers and deterministic probes before the Linux host is available. From PowerShell in the repository root:

```powershell
$env:PYTHONPATH='ingestion'
.\.venv\Scripts\python emulation\desktop_smoke.py --repetitions 2 --scan > emulation\desktop-smoke-report.json
```

The smoke harness uses Docker internal networks, read-only containers, tmpfs configs, and no published ports. It checks eight secure/vulnerable fixtures and a two-Nginx proxy chain per repetition, runs bounded Nmap checks on each service and the curated Nuclei template on Nginx, samples resource use, and checks cleanup. It does **not** apply the Linux host `iptables` policy or assert host/LAN/internet egress isolation; it cannot replace the dedicated Linux acceptance run above.

On 2026-10-25, the two-pass Docker Desktop smoke report in `emulation/desktop-smoke-report.json` passed 18/18 cases with consistent verdicts, 16/16 Nmap checks, 4/4 Nuclei checks, and no leftover labeled containers or networks. Docker reported 12 CPUs and 8,183,758,848 bytes of available memory. The highest post-probe sample was 10m CPU and 69 MB RAM; these samples are not a continuous peak measurement.

## Coverage and evidence limits

- Path universe: explicitly classified endpoints, directed observed/inferred edges, simple paths, hop and enumeration caps. The planner reports excluded edge types and truncated state.
- A wave is scheduled coverage. Only a confirmed path-specific end-to-end check counts as validated coverage. Other paths remain unvalidated even if a constituent service probe passes.
- Nmap uses a bounded TCP connect check on the registered twin port only. Nuclei receives a single local curated HTTP template, disabled update/Interactsh features, and low rate/concurrency bounds. Service probes use synthetic credentials/data.
- A `not_reproduced` verdict means the behavior was not reproduced in that twin under its recorded prerequisites. It says nothing definitive about the source host.
- The resource peak is sampled from Docker statistics after probe stages. A dedicated lab run is required to check the hardware-specific budget and latency targets.

