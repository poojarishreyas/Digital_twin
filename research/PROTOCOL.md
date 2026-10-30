# Declared experimental protocol

## Questions and hypotheses

H1: Configuration synchronization changes measured policy outcomes relative to default twins. H2: TwinHunter discovers supported conditions missed by fixed tests under equal declared resource limits. H3: Selective scheduling reduces measured resource cost over retaining all containers for a fixed horizon while preserving the declared candidate universe. H4: Security retesting plus legitimate-workflow checks rejects patches that only appear successful because they break the service. These are hypotheses, not guaranteed contributions or publication claims.

## Ground truth

`scenarios.json` declares 20 scenarios before evaluation: four Nginx, four PostgreSQL, four Redis, four OpenSSH, two proxy chains, and two intentional unsupported cases. Weaknesses are policy-specific: version disclosure, unauthenticated query/PING access, and synthetic password login. The SSH fixture uses a synthetic known password to test configured behavior; it is not password cracking or proof that a production credential is weak.

The scenario's proposed truth is verified with an independent client implementation in `oracle.py`, which does not invoke the TwinHunter security classifier. Raw client responses, source snapshot and image IDs are saved in `ground-truth.json`. A mismatch remains unverified and is excluded from quality denominators, while its run and failure remain in the raw data. Expectations are not rewritten to match the proposed system. Both implementations are maintained in the same repository, so external expert validation is still needed before publication.

## Four configurations

1. Static configuration/version assessment: explicit service rules with no runtime probes. Results are labeled static inference. It is intentionally a competent baseline, rather than a strawman version-only scanner.
2. Default twins: pinned service versions and dependency wiring, with declared policy defaults (Nginx header on, Redis protection on, SSH password login off, PostgreSQL SCRAM). Source fidelity exclusions are still enforced. Defaults are an experimental profile, not a claim about every vendor distribution's defaults.
3. Synchronized deterministic twins: supported source policy preserved; the scenario's deterministic security test executes.
4. Synchronized TwinHunter: the same source policy, images and tool catalog, with test selection from the pinned model. It sees sanitized configuration and registered target IDs, not ground-truth labels or scenario descriptions. No endpoint means an unavailable run, never an inferred AI result.

Every method receives the same scenario list, source versions, fidelity exclusions, 2000m CPU / 2048 MB sandbox ceiling, and ordered repetitions. AI gets additional explicit token/step/time limits. Total resource cost includes model compute when available; the present Docker measurements exclude model GPU use. Default and synchronized twins are created separately. Oracle cost is reported as setup and excluded from method detection time. There is no claim of an equal model-GPU budget for deterministic methods.

## Metrics and denominators

Precision = TP/(TP+FP); conclusive recall = TP/(TP+FN); F1 = 2TP/(2TP+FP+FN); false-positive rate = FP/(FP+TN). These use only independently labeled, conclusive runs. Coverage, unsupported, unavailable and inconclusive/error rates are reported beside them. All-labeled recall includes abstentions as undetected known positives. Zero denominators produce null. An unavailable AI row is not a measured false negative in the conclusive confusion matrix.

Detection time includes twin startup and the test/decision loop, excludes oracle setup, and is measured by a monotonic clock. Readiness is separately recorded. Docker memory and CPU are sampled every 0.5 seconds with cumulative CPU counters and integrated MB-seconds; peaks can miss shorter spikes and sampling itself incurs overhead. Hard per-container limits and total admitted budgets remain active. Sampling failures are counted. Record the Docker engine, assigned CPUs/RAM, images, Python dependencies, model revision, dtype, context, framework and seeds.

Patch success = accepted/attempts for the declared seeded set. Regression rate = candidates with a passing original legitimate workflow and failing candidate workflow / all attempted candidates. These are test-suite control statistics, not general production repair rates. Synchronization latency and agent overhead require separate Phase 1 instrumentation; unmeasured values remain null. AI tokens require server usage, with conservative pre-request reservations reported separately. Cost requires actual provider/GPU billing rates; it is not presumed zero for open weights.

Use at least three independent seeds for stochastic AI experiments and retain failures. The initial local deterministic run uses two repetitions. Report per-repetition accuracy, standard deviation where defined, and per-scenario variability; do not mistake variation across scenarios for repeated-seed variability. No statistical significance is claimed from the small fixture set.

## Scheduling and scale

`scheduling.py` uses a real four-service matched subset, a declared candidate edge and two identical tested targets. The greedy planner selects the required service bundle. The selective policy cleans it after testing; the always-on policy retains all four services until the fixed 20-second horizon. Both use the same 2000m/2048 MB ceiling. This is a narrow lifecycle experiment; resource ratios must not be extrapolated to arbitrary workloads.

The separate 100-node graph is entirely synthetic and tests planner behavior only. It represents zero physically instrumented hosts. Full VMs are a separately declared, tractable matched-subset experiment when controlled hardware/backend support is available; otherwise the exclusion is explicit.

## Reproduction and scope

Follow `docs/phase3.md`. Keep all JSON, CSV, tool traces, oracle evidence, patch artifacts and plots. Hash the manifest and code, and retain observed dependency inventories. Docker Desktop results are development smoke evidence. The isolated Linux acceptance run and live model benchmark must pass before claiming Phase 3 exit. Source machines remain untouched.
