# Measured artifacts

- `repeated/`: authoritative two-repetition deterministic benchmark, 160 declared rows, independent wire-oracle evidence, four patch controls, plots and generated tables. Forty AI rows are explicitly unavailable; unsupported cases are retained.
- `scheduling.json`, `scheduling-results.md`, `scheduling-cost.png`: three repetitions of the matched four-service lifecycle comparison. The 100-node graph is synthetic.
- `replay-integration.json`: scripted decisions through the real attached Docker tool path, including an enforced blocked action. This is not an AI benchmark.
- `storage-smoke.json`: real PostgreSQL round-trip, concurrent duplicate handling, immutable run IDs and stored hunt traces.
- `local/`, `pilot2/`: earlier pilot artifacts retained for transparency. Their CPU counters omitted usage before the first sample, so those CPU totals are lower bounds. Use `repeated/` for the corrected resource measurements.

Docker Desktop results verify supported service behavior, not the dedicated Linux host/LAN/internet isolation gate. Model quality, GPU tokens/cost, instrumented-host overhead/synchronization, and full-VM comparisons remain unmeasured. Post-validation provenance describes the final repository inventory and does not retroactively attest that all earlier pilots used identical source code.
