# Matched scheduling subset

Three repetitions; four real service containers; identical two tested targets; 20-second always-on horizon.

| Policy | CPU seconds, mean ± SD | MB seconds, mean ± SD | Peak RAM MB, mean ± SD |
|---|---:|---:|---:|
| selective | 1.063 ± 0.098 | 51.572 ± 5.113 | 14.969 ± 0.233 |
| always_on | 2.048 ± 0.099 | 389.233 ± 11.814 | 25.542 ± 0.156 |

This measures the declared lifecycle policy only; it does not establish security-path coverage or general fleet savings.
The separate 100-node graph contains zero physically instrumented hosts. Full-VM comparison was not run.
