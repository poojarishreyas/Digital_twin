# Threat-hunting tailoring of the Elemental harness

This is a **copy** of the Elemental harness, tailored to drive this project's bounded
security executor. The original at `~/Desktop/Elemental_harness` is untouched.

## What was added

Nothing in the harness core was patched. The integration is one config overlay that
mounts an **external MCP server** — this project's threat-hunter — so the harness
model can call the typed security tools as native tools:

```
mcp__hunter__inspect_config   mcp__hunter__scan_service    mcp__hunter__security_check
mcp__hunter__run_nuclei       mcp__hunter__http_probe      mcp__hunter__tcp_probe
mcp__hunter__database_probe   mcp__hunter__http_headers    mcp__hunter__redis_config
mcp__hunter__ssh_auth_methods mcp__hunter__test_patch
```

The server lives in the Python project at
`ingestion/twin_ingestion/phase3/mcp_server.py` and reuses the existing, tested
`ToolExecutor` and typed contracts. That means the harness gets a smarter agent loop
(planning, tool-use, the Claude Agent SDK or Gemini) while the **safety model is
unchanged**: every call is validated against the typed action schema, the executor
enforces target/port/rate/step/time limits and DNS pinning, and **only executed
observations count as evidence** — a model claim never becomes a finding.

```
Elemental agent loop ──calls──> mcp__hunter__* (MCP stdio)
        │ (Gemini via llm-pi-ai, or the Claude Agent SDK)
        ▼
  Python ToolExecutor  ──bounded probes──>  registered twin targets
  (typed actions, limits, DNS pin, evidence ledger)
```

## Prerequisites

- The Python project set up with its venv (the harness calls it as a subprocess).
- `pnpm install && pnpm run build` in this folder (first time).
- A **targets file** describing what to hunt — copy `hunter-targets.example.json`
  and edit the ids/hosts/ips/ports (the example matches the AWS lab).

## Run

```sh
export OMNIROUTE_API_KEY=...        # your OmniRoute gateway key (not written into any file)
export HUNT_PY=/abs/path/to/digital_twin/.venv/bin/python        # Windows: ...\.venv\Scripts\python.exe
export TWIN_INGESTION_PATH=/abs/path/to/digital_twin/ingestion
export TWIN_HUNT_TARGETS=/abs/path/to/digital_twin/threat-harness/hunter-targets.json

pnpm install && pnpm run build      # first time only
pnpm start -- --dump-config --patch cordis.patch.threat.yml   # verify the tree composes
pnpm start -- --patch cordis.patch.threat.yml                 # run; Web GUI on http://127.0.0.1:3080
```

OmniRoute must be running and reachable at `http://127.0.0.1:20128/v1` during the hunt.

The Web GUI serves on http://127.0.0.1:3080. In a session, ask the agent to assess a
target (e.g. "check the Redis cache for unauthenticated access and the web host for
version disclosure"); it will call the `mcp__hunter__*` tools and report only what it
actually observed. `pnpm start -- --dump-config` shows the mounted plugin row.

## Choosing the model

`cordis.patch.threat.yml` already sets the model to **Gemini 3.8 Flash through
OmniRoute**: it declares an `omniroute` route on `@elemental/llm-pi-ai`
(`baseURL: http://127.0.0.1:20128/v1`, model `lynx-harness`, key from
`OMNIROUTE_API_KEY`) and makes it the agent default. To use Claude instead, swap the
`agent-default-model` row to the bundled `@anthropic-ai/claude-agent-sdk` route. Keep
the model + run date recorded with any results — a hosted model is not weight-pinned,
and OmniRoute can fail over between upstreams.

## Safety / scope

Only registered targets and ports are reachable; off-policy requests are rejected
before anything runs; a blocked call yields no evidence. Point it only at your own
disposable twins or an authorized lab with synthetic data. The `test_patch` tool
needs a patch verifier and is a no-op unless one is wired in.

## Notes / limitations

- Two target modes (`TWIN_HUNT_MODE`):
  - **`direct`** (default): probes run against the configured live service IPs
    (`TWIN_HUNT_TARGETS`). Not a rendered twin, so config fidelity is unverified.
    Point it only at authorized lab targets.
  - **`sandbox`**: builds a **disposable twin** from `TWIN_HUNT_SCENARIO`
    (see `hunter-scenario.example.json`) via the Phase 2 sandbox and hunts that,
    tearing it down on exit. Needs Docker; `TWIN_HUNT_SANDBOX_MODE=linux_isolated`
    additionally needs a Linux host with the host/LAN/internet positive controls
    (`desktop_smoke` works on Docker Desktop but without the isolation guarantee).
- The MCP bridge adds no dependency to the Python venv (plain JSON-RPC over stdio).
- Tests: `pytest ingestion/tests/test_mcp_server.py`.
