# Matched scheduling subset

Three repetitions; four real service containers; identical two tested targets; 20-second always-on horizon.

| Policy | CPU seconds, mean ± SD | MB seconds, mean ± SD | Peak RAM MB, mean ± SD |
|---|---:|---:|---:|
| selective | 0.817 ± 0.039 | 39.103 ± 4.326 | 14.672 ± 0.379 |
| always_on | 1.766 ± 0.057 | 409.408 ± 4.143 | 25.723 ± 0.214 |

This measures the declared lifecycle policy only; it does not establish security-path coverage or general fleet savings.
The separate 100-node graph contains zero physically instrumented hosts. Full-VM comparison was not run.
