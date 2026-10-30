# Digital Twin — Phase 1: Continuous Discovery and Graph Twin

## Goal

Build a passive, continuously updated inventory and graph twin for Windows and Linux lab hosts. Phase 1 collects evidence, models current state, and computes bounded candidate paths. It does not probe services, launch service twins, choose attacks, or modify production configuration.

## Functional scope

1. A Go service agent enrolls with a stable local identity, takes a baseline snapshot, watches supported configuration files, and periodically polls processes/sockets.
2. Collection covers OS identity, installed/running services and detectable versions, listening ports, established outbound connections, supported firewall rules, local privilege metadata, and allowlisted settings for Nginx, PostgreSQL (`postgresql.conf` and `pg_hba.conf`), Redis, and OpenSSH.
3. Parsers retain source order and repeated directives/sections. Values matching secret-bearing directives are replaced before they enter telemetry or logs. Access failures and unsupported collectors are first-class collection gaps.
4. Canonical components receive SHA-256 hashes. The agent emits a full snapshot on first connection/reconciliation and deltas afterward. A persistent sequence and disk-backed outbox provide at-least-once delivery; the server handles duplicates idempotently.
5. Telemetry travels over gRPC protected with mutual TLS and is validated against a versioned JSON Schema at ingestion.
6. Neo4j stores hosts, services, identities, topology relationships, timestamps, and evidence provenance. PostgreSQL stores ingestion/run history and measurements.
7. Observed connections, inferred reachability, and confirmed attack transitions are distinct edge types. Phase 1 never promotes an observed connection to a confirmed attack transition.
8. Candidate paths are bounded traversals from declared entry assets to critical assets over observed/inferred edges. Equivalent supported configurations share an archetype node while each service instance retains its host-specific identity and edges.
9. A React/TypeScript UI shows inventory, topology, telemetry gaps, stale agents, evidence, and bounded candidate paths.

The candidate-path view also declares its traversal universe and truncation, flags stale or incomplete evidence per route, and ranks intermediate assets by their occurrence in returned paths. Read-only isolation previews show which returned routes would be interrupted under a stated asset-removal assumption. These are investigation aids; they do not predict attacker intent, assign exploitation probabilities, or validate a chain. Entry and critical roles can be declared in the dashboard.

## Acceptance criteria

- One Windows and one Linux lab host can run as a service and report a baseline.
- Configuration edits, port changes, and service removal converge without duplicate graph assets after replay or reconnect.
- Seeded secrets never appear in envelopes, server logs, or sanitized configuration records.
- Permission failures and unsupported data are shown as collection gaps.
- Known connections and candidate paths have evidence timestamps and types.
- Archetype grouping does not merge host identity or topology.
- CPU, RAM, bytes sent, collection duration, event-to-graph latency, polling interval, and hardware metadata are retained.

## Non-goals

- Active scanning, exploitation, AI-directed probing, service twins, credential use, configuration remediation, and production changes.

## Security and operational requirements

- Client certificates identify enrolled agents; server certificates are verified against the configured CA.
- Private keys and generated telemetry/outbox data are never committed.
- Export is deny-by-default: only explicitly allowlisted fields are serialized.
- Raw configuration files and command output are not logged.
- Outbox writes are atomic and bounded; overflow is visible as a collection gap and forces a full reconciliation.
- Default candidate traversal is depth 4 with a hard server maximum of 8.

## Deliverables

- `agent/`: cross-platform Go source, service installation helpers, collectors, parsers, canonicalization, hashing, event loop, and durable synchronization.
- `schema/`: telemetry JSON Schema and example envelope.
- `ingestion/`: Python gRPC receiver, validation, duplicate handling, Neo4j/PostgreSQL persistence, reconciliation, metrics, and read API.
- `ui/`: React/TypeScript inventory and live graph.
- `deploy/`: containers, database bootstrap, and local lab certificate tooling.
- `tests/`: parser, sanitization, schema, and ingestion behavior tests.

# Phase 2 — Selective Emulation and Deterministic Validation

## Goal and boundary

Turn a bounded selection of supported graph state into disposable service twins on a dedicated Linux lab host. Evidence describes only the rendered twins under the recorded test conditions. A failed check never proves the enrolled host secure, and a single tested service does not validate an entire path.

## Planning

- Entry and critical assets must be explicitly classified in the Phase 1 graph. Directed observed/inferred edges form the candidate universe; confirmed attack transitions are excluded from planning. Paths are simple, at most eight hops, with a 500-path and 10,000-expansion cap. Truncation and excluded edges are reported.
- The planner greedily chooses whole service bundles by newly covered paths divided by normalized CPU/RAM cost. It is a path-coverage heuristic, not an exact minimum vertex-cut algorithm.
- A wave contains all mapped dependency services for every path it claims to plan. Paths that cannot fit are untested. A run marks a path validated only after a path-specific end-to-end test confirms the chain.

## Emulation and validation

- Catalog mappings are pinned for linux/amd64. A version mismatch, unsupported directive, missing configuration record, or unsafe/unrenderable value is a visible fidelity gap and prevents a false validation claim.
- Nginx, PostgreSQL with ordered `pg_hba.conf`, Redis, and OpenSSH render only supported semantics. Authentication uses synthetic lab accounts and passwords. Redis `requirepass` is represented as a redacted marker before transport and replaced by a synthetic sandbox password.
- A dedicated Linux worker owns Docker and host firewall control. Workloads receive no Docker socket or host bind mounts, run on per-run internal networks, and have resource/pid limits. Each target has a probe network; only planned service pairs share a separate link network.
- The worker establishes host firewall rules before attaching workloads. It verifies designated host/LAN/internet positive controls from the Linux host and denied access from a probe workload, as well as allowed access to the registered twin. These checks are required before Nmap, a curated Nuclei template, or service-specific behavior probes.
- Findings contain target, snapshot hash, image ID, test ID/version, prerequisites, bounded observations, verdict, and fidelity gaps. Supported verdicts are confirmed, not reproduced, inconclusive, and unsupported.
- Labeled resources are removed at the end of each wave and reconciled after worker restart. The UI shows planning coverage, actual path validation, wave health, evidence, and cleanup.

## Acceptance

The eight fixed single-service fixtures, one two-service proxy scenario, designated isolation destinations, repeated verdicts, and sampled resource limits must pass on a dedicated Linux sandbox host. The Windows development workstation can compile and unit-test the implementation but cannot satisfy runtime acceptance without Docker and the Linux environment.

# Phase 3 — AI Hunting, Remediation, and Research Evaluation

## Objective and implementation

Add a bounded TwinHunter loop, disposable patch verification, an evidence dashboard and a reproducible comparison against simpler methods. `ingestion/twin_ingestion/phase3` implements typed actions, independently enforced limits, a pinned local-model adapter, structured evidence traces and patch artifacts. Optional remote model calls originate in the control plane over authenticated HTTPS. Probe workloads retain isolated networks and no model endpoint access, Docker control socket, host mounts or arbitrary shell tool.

The tool registry admits exact targets and ports, GET/HEAD on allowlisted paths, TCP connect, a fixed PostgreSQL query, bounded Nmap and a curated Nuclei template. Resolved destinations and redirects are validated; HTTP is pinned to the registered IP. Unknown tools/fields are rejected. Rate, process timeout, wall time, step and conservative cumulative token limits are enforced outside the model. Config comments and service responses are untrusted input. Only executed tool observations can confirm a finding; model hypotheses and inferred paths remain distinct.

Candidate edits apply to disposable copies. Verification checks original behavior, original legitimate workflow, candidate syntax/startup, security retest and candidate legitimate workflow. Results retain diff, rollback, snapshot/image IDs, checks and fidelity limitations. Accepted candidates are labeled “verified in the tested twin scenario.” No production patching, compatibility or zero-downtime claim follows.

## Evaluation and deliverables

`research/scenarios.json` declares 20 scenarios with policy weaknesses, ordered configuration controls, two proxy chains and explicit unsupported cases. A separate wire-client implementation verifies proposed labels. Four configurations share the declared set and budgets: static config/version rules; default twins; synchronized deterministic twins; synchronized TwinHunter. Missing model access and unsuccessful cases remain visible in JSON/CSV.

`research/scheduling.py` compares selective lifecycle scheduling with always-on containers on a matched real service subset. A 100-node synthetic graph is labeled separately from physically instrumented hosts. Full-VM comparison is excluded when no controlled matched backend is available. Exports cover confusion-matrix metrics, coverage, unsupported/inconclusive/unavailable rates, elapsed/readiness time, sampled peaks and total CPU/memory-time, patches and regressions. Agent overhead, synchronization, model tokens and billing remain null when unmeasured. Repetitions and variability are retained.

The dashboard extends inventory and topology with candidate/validated paths, research reports, AI action traces, evidence, patch diffs/rollback artifacts and CSV/JSON exports. PostgreSQL stores immutable research reports. The primary TwinHunter model is Gemini 3.8 Flash through the OmniRoute `lynx-harness` gateway; every decision records the response model, and decisions from any other upstream are rejected. A secondary local profile pins Qwen3.8-27B revision, dtype, context and serving framework; actual GPU availability is checked. Google subscription wording is not treated as a guarantee of 80GB VRAM or model superiority.

`docs/phase3.md`, `research/PROTOCOL.md` and `research/manuscript.md` document architecture, methods, related work, hypotheses, measured results, limitations and reproduction. Manuscript plots/tables are generated from raw data. Replay-model boundary tests are identified as test doubles and never reported as live AI performance.

## Exit criteria and pending runtime gates

- TwinHunter executes the declared scenarios with the pinned model, enforced tool boundaries, blocked-action tests and complete evidence traces.
- Patch controls accept the seeded valid fix and reject invalid, ineffective and workflow-breaking changes.
- Every finding/patch carries source snapshot, supported fidelity, executed checks and evidence.
- All four methods execute under documented budgets; unsupported cases and failed runs remain in the dataset.
- Clean setup reproduces the workflow. The manuscript reports observations without fabricated performance or publication guarantees.

Local deterministic success does not close live GPU-model, isolated Linux, instrumented-host or full-VM gates. The reports identify which measurements were executed and which remain unavailable.

# Private-company pilot hardening

The first deployment is a private installation for one company. The control plane
adds individual expiring credentials, browser sessions, viewer/operator/admin
authorization, persistent access intent/outcome audit, request limits, resource
budget enforcement and bounded queue admission. Company Compose configuration
uses private HTTPS ingress and internal database ports. A read-only preflight and
cold backup/new-volume restore tool accompany the deployment runbook.

This is a single-instance pilot architecture. It does not yet close production
identity/PKI revocation, least-privilege database provisioning, independent audit
storage, signed release/security review, representative load testing or the
remaining physical-lab Phase 1–3 gates. See `docs/company-deployment.md` and
`docs/company-hardening-status-2026-10-27.md` for implementation evidence and
explicit outstanding checks. A passing local integration run is not a production
readiness or vulnerability-detection guarantee.

