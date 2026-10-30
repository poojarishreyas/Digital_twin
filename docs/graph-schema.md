# Graph schema

## Nodes

| Label | Stable key | Purpose |
|---|---|---|
| `Asset:Host` | `id` (agent-generated, persisted locally) | Host identity and current OS/hardware summary |
| `Asset:Component` | `id` (host-scoped) | Service, listener, firewall, privilege, configuration, identity, or process instance |
| `Archetype` | `hash` (canonical supported config only) | Reusable behavior-equivalent supported configuration |
| `Asset` | `id` | An endpoint observed before its enrolled host identity is known |

Stable host/component identity is never derived from configuration content. `INSTANCE_OF` connects a host-scoped configuration instance to a content archetype.

## Relationships

Ownership edges (`HAS_SERVICE`, `HAS_LISTENER`, `HAS_FIREWALL`, `HAS_PRIVILEGE`, `HAS_CONFIGURATION`, `HAS_IDENTITY`, `HAS_PROCESS`) retain host topology. Every evidence edge has source, observed timestamp, confidence, and last-seen time.

- `OBSERVED_CONNECTION`: a socket was established. This says nothing about other routes or exploitability.
- `INFERRED_REACHABILITY`: a declared inference rule produced a possible route. Phase 1 stores/imports this edge but does not infer it from an established socket alone.
- `CONFIRMED_ATTACK_TRANSITION`: an authorized external process confirmed a transition. Phase 1 cannot create this from agent telemetry.

Full snapshots remove host-owned components absent from the snapshot. Every envelope replaces the reporting host's current observed/inferred connection set. Sequence receipts and metric history remain in PostgreSQL.

