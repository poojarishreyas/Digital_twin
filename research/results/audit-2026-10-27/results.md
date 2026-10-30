# Measured results

Run `fd0bb7a4-da02-4459-8bf3-3cdfbdb02dcd`; mode `desktop_smoke`; manifest `6b0d55a98d433267aafe6990beb25c180445832360ca2921727a0f6b428790be`.

| Method | Runs | Conclusive | Precision | Recall | F1 | Unsupported | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---:|
| static_assessment | 6 | 5 | 1.000 | 1.000 | 1.000 | 0.167 | 0.000 |
| default_twins | 6 | 5 | 1.000 | 0.400 | 0.571 | 0.167 | 0.000 |
| synced_deterministic | 6 | 5 | 1.000 | 1.000 | 1.000 | 0.167 | 0.000 |
| synced_twinhunter | 6 | 0 | not measured | not measured | not measured | 0.000 | 1.000 |

Static rules and synchronized deterministic twins must be compared directly: a tie provides no evidence of improved detection over static assessment.
These fixtures test specific policy behaviors. Version disclosure and synthetic password login are not proof of an exploitable production vulnerability.

## Patch controls


Unsupported and unavailable cases remain in JSON/CSV. Quality metrics condition on conclusive independent labels; coverage is reported separately.
No GPU tokens/cost, agent overhead, synchronization latency, or full-VM costs are claimed where no measurement exists.
