# Local acceptance on existing Docker Desktop

These checks ran on the existing Windows workstation without additional VMs, cloud machines, GPU allocation, or image downloads. Docker reported 12 CPUs and 8,183,742,464 bytes of available memory. Scope is `desktop_smoke`; this record does not establish dedicated Linux firewall isolation or real two-OS agent enrollment.

## Observed results

| Check | Result | Evidence |
| --- | --- | --- |
| Independent behavior oracle | All 18 supported scenarios verified; two unsupported scenarios retained with explicit reasons | [ground-truth.json](../research/results/desktop-acceptance-2026-10-27/ground-truth.json) |
| Four declared baseline slots, 20 scenarios, two repetitions | 160 rows: 108 completed static/deterministic assessments, 12 unsupported, 40 unavailable AI assessments; no execution errors or verdict disagreements between repetitions | [report.json](../research/results/desktop-acceptance-2026-10-27/report.json), [results.csv](../research/results/desktop-acceptance-2026-10-27/results.csv) |
| Four patch controls | Valid fix verified in the tested twin scenario; invalid, ineffective, and workflow-breaking changes rejected | `patches` in the benchmark report |
| Four service adapters and Nginx dependency chain | 18/18 cases passed across two repetitions; 16 Nmap port checks and four curated Nuclei checks passed; no leftover containers or networks | [service-scan-report.json](../research/results/desktop-acceptance-2026-10-27/service-scan-report.json) |
| Interrupted run recovery | Exception left no resources; abrupt process exit left two containers and one network; reconciliation removed all three | [cleanup-report.json](../research/results/desktop-acceptance-2026-10-27/cleanup-report.json) |
| Attached TwinHunter tool integration | Scripted decisions exercised real twin tools, recorded a blocked unregistered target, retained source snapshot evidence, and cleaned up | [replay-integration.json](../research/results/desktop-acceptance-2026-10-27/replay-integration.json) |
| Selective versus always-on lifecycle | Three repetitions per policy over four real service containers and identical two tested targets; resource measurements exported | [scheduling-results.md](../research/results/desktop-acceptance-2026-10-27/scheduling-results.md) |
| Python regression suite | 49 tests passed; one dependency deprecation warning | `python -m pytest -q ingestion/tests` |

Static assessment and synchronized deterministic tests both have F1 1.0 on the conclusive labels in this small fixture set; default-config twins have F1 0.4. The tie provides no evidence of improvement over static assessment. These policy fixtures do not establish general vulnerability detection quality. AI quality remains unmeasured.

Plots and metric summaries are beside the raw results. Scheduling measurements describe the declared lifecycle policy and sampled container costs. The 100-node planner graph is synthetic, with zero instrumented hosts. No full-VM costs were measured.

## Boundaries still requiring acceptance evidence

- Real Windows and Linux agents installed as services, including real configuration edits, port changes, disconnect/reconnect, permission gaps, seeded-secret checks, hardware details, and CPU/RAM/bandwidth/synchronization measurements.
- Linux host firewall policy and positive-control destinations demonstrating allowed twin paths and blocked host, LAN, and internet access. Docker internal networking alone does not establish this.
- Live model-assisted hunting, all four baselines with a configured live model, stochastic variability, and actual AI token/cost records. The OmniRoute TCP port was reachable, but no API key was available in the execution environment. Live hunting also retains the existing Linux isolation prerequisite.

No additional infrastructure is required to reproduce the local checks above. Full Phase 1–3 acceptance remains conditional on the outstanding evidence.
