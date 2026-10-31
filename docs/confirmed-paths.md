# From findings to proven attack paths

Candidate paths come from observed traffic. Sandbox findings come from the bounded harness. This bridge joins them: an executed, confirmed finding upgrades the hops that reach it, so a candidate path becomes **partially confirmed** or **proven**.

## Rule for a confirmed hop X → H

Both halves of the evidence are required:

1. **Reachability to the specific service:** the agent on X observed a connection to H's address **on the port of that service**. The port comes from H's own listener (for example `0.0.0.0:6379` owned by `redis-server`). The address must belong to exactly one enrolled host; unknown or ambiguous addresses are never guessed.
2. **Executed weakness:** an isolated replica of that same service on H produced a finding with verdict `confirmed`. `not_reproduced`, `inconclusive` and `unsupported` never qualify.

A sandboxed chain scenario (`scenario.http_chain`) that passed confirms each hop of its route, but only when every node on that route is an enrolled host.

A weakness on a port the source never reached confirms nothing. For example, if the web server only talks to the catalog on 8081, a confirmed Redis weakness on 6379 on the same machine does **not** confirm the web → app hop.

## Guarantees

- **Only this step writes confirmed edges.** Agent telemetry that claims a confirmed edge is rejected at ingestion, and agent updates never remove confirmed edges.
- **Confirmed edges never create routes.** Routes still come from observed or inferred connectivity; confirmation only upgrades their hops.
- **Tenant scoped, operator triggered.** `POST /api/emulation/runs/{run_id}/promote` needs the operator role, reads only the caller's tenant run and topology, and accepts only completed runs. Writing the same run twice keeps one edge per hop.
- **Path status:** `proven` when every hop is confirmed, `partially_confirmed` with a count when some are, otherwise `unvalidated`.

## Using it

1. Run a sandbox simulation (Phase 2) on the discovered services.
2. On the finished run, click **Confirm hops in twin** (Simulations page, also reachable at `#simulations`).
3. Open **Attack paths**: routes show `proven` or `N/M confirmed`, and each confirmed hop shows the run that proved it.

Code: `ingestion/twin_ingestion/confirmation.py`, `path_analysis.py`, `graph.py` (`record_confirmations`). Tests: `ingestion/tests/test_confirmation.py`.
