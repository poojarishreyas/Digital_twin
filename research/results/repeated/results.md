# Measured results

Run `011dd1b9-5907-43f9-a5fb-852ff08ed09f`; mode `desktop_smoke`; manifest `6b0d55a98d433267aafe6990beb25c180445832360ca2921727a0f6b428790be`.

| Method | Runs | Conclusive | Precision | Recall | F1 | Unsupported | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---:|
| static_assessment | 40 | 36 | 1.000 | 1.000 | 1.000 | 0.100 | 0.000 |
| default_twins | 40 | 36 | 0.500 | 0.333 | 0.400 | 0.100 | 0.000 |
| synced_deterministic | 40 | 36 | 1.000 | 1.000 | 1.000 | 0.100 | 0.000 |
| synced_twinhunter | 40 | 0 | not measured | not measured | not measured | 0.000 | 1.000 |

Static rules and synchronized deterministic twins must be compared directly: a tie provides no evidence of improved detection over static assessment.
These fixtures test specific policy behaviors. Version disclosure and synthetic password login are not proof of an exploitable production vulnerability.

## Patch controls

- valid: verified in the tested twin scenario.
- invalid: rejected.
- ineffective: rejected.
- breaking: rejected.

Unsupported and unavailable cases remain in JSON/CSV. Quality metrics condition on conclusive independent labels; coverage is reported separately.
No GPU tokens/cost, agent overhead, synchronization latency, or full-VM costs are claimed where no measurement exists.
