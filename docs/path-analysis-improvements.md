# Evidence-aware candidate path analysis

This improvement supports proactive investigation of routes from entry assets to critical assets. It does not predict attacker intent or establish that a candidate route is exploitable.

## User workflow

1. Select an asset in the topology or service inventory.
2. In Evidence detail, declare it an entry asset, a critical asset, or both, and save.
3. Choose a hop limit in Candidate paths and evidence.
4. Inspect each route's ordered evidence, timestamps, freshness, missing provenance, and agent collection gaps.
5. Review intermediate assets shared by several returned paths. Simulate isolating an asset to see affected and remaining returned routes.
6. Refresh incomplete telemetry and use supported isolated scenarios to validate each transition and its prerequisites. Refer to the run evidence view for actual twin validation results.

## Implementation

- One bounded, deterministic enumerator is shared by candidate analysis and emulation planning. It deduplicates typed edges and caps total scheduled traversal states at 10,000 and returned paths at 500. Paths stop at the first critical asset.
- The response declares endpoints, hop bounds, excluded edge kinds, snapshot/traversal truncation, generation time, and the freshness threshold. An empty result or a truncated result is never labeled safe.
- Path IDs depend on ordered asset IDs and edge kinds, preserving host identity. Archetype membership never creates an attack route.
- Remote socket endpoints are not automatically resolved to enrolled host identities. Unresolved endpoints are visible telemetry issues and can prevent multi-hop enumeration. Host/service ownership is not treated as proof of network access or a privilege transition.
- Review order is shorter paths first, then fewer telemetry issues. Shared-asset ordering counts returned path occurrences. Neither is an exploitation probability, exact minimum cut, or proof that a proposed change will work.
- Isolation previews are read-only asset-removal calculations over the returned candidate universe. They do not apply firewall rules or modify the graph. Security and legitimate-workflow checks are still needed for real changes.
- Every candidate remains `unvalidated`, even when its recorded telemetry is current. Findings on individual twins do not confirm an entire chain.

## Ingestion trust boundary

Passive agent credentials are scoped to the enrolled host. Components, removals, and structural relationships must use that host's canonical namespace. Agents cannot manufacture confirmed attack transitions. Invalid payload values are omitted from rejection logs and replies, preventing malformed telemetry from leaking seeded secrets through validation diagnostics.

## Verification

- 64 Python tests pass, including alternate-route preservation, immutable isolation previews, stable IDs, duplicate edges, traversal limits, evidence freshness, agent gaps, namespace enforcement, and rejection-log redaction.
- TypeScript/Vite production build passes.
- `research/audit_ingestion.py` exercises the running mTLS ingestion API, Neo4j, and PostgreSQL with synthetic Windows/Linux identities and a two-hop route. It checks read-only previews and rejects cross-host writes and forged confirmations.
- The live checks passed after the changes, including a malformed seeded-secret payload whose contents were absent from replies and ingestion logs. Results are retained in [path-analysis-integration-2026-10-27.json](../research/results/path-analysis-integration-2026-10-27.json).
- Browser visual inspection was attempted, but the automation runtime failed to initialize with `failed to write kernel assets`. The UI build and live API checks do not substitute for that visual inspection.

Existing Phase 1–3 lab acceptance gates remain documented in `docs/audit-2026-10-27.md`; this change does not claim live AI discovery quality or dedicated Linux isolation.
