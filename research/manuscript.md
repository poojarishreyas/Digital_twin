# Configuration-Synchronized Service Twins for Bounded Security Validation

**Research manuscript draft — preliminary local measurements; live AI evaluation pending.**

## Abstract

We describe a prototype that links passive infrastructure telemetry to bounded service emulation, deterministic security observations, and disposable configuration patch verification. A typed control-plane loop, TwinHunter, can request tests from a pinned open-weight model while an external executor enforces target and resource limits. The local benchmark contains 20 declared policy scenarios, including secure controls, ordered PostgreSQL authentication rules, proxy chains and unsupported state. Independent wire checks validate 18 supported labels. In the initial local run, static configuration rules and synchronized deterministic twins both obtain F1 1.00 on the conclusive supported subset; default-configuration twins obtain F1 0.40. These results demonstrate fixture sensitivity to configuration, but provide no evidence of detection improvement over the static baseline. The live model is not hosted in this environment and its results are explicitly unavailable. Four seeded patch controls produce one accepted valid fix and three rejected invalid, ineffective or regressing changes. Docker Desktop measurements do not establish the Linux isolation acceptance gate.

## 1. Motivation and contribution hypotheses

Observed connections provide evidence of communication but do not establish exploitability. Service versions also omit behavior selected by access-control, authentication and other configuration. A reproducible service twin can test a declared behavior without applying changes to the original host, provided that unsupported versions and semantic gaps are visible. We investigate four hypotheses: configuration fidelity affects default-twin conclusions; bounded AI selection adds value over fixed tests; path-aware selection reduces resource cost; and legitimate-workflow checks improve patch rejection. The current implementation supports evaluating these hypotheses; the prototype's existence does not establish them.

## 2. Related work

ReAct interleaves language-model reasoning and actions to gather information from environments [1]. TwinHunter adopts an observation/action loop but records short hypotheses rather than treating model reasoning as evidence. PentestGPT studies LLM-assisted penetration testing and the challenges of maintaining task context [2]. Our present experiments are narrower: small, supported configuration behaviors in disposable twins, with an intentionally restricted tool set. AgentDojo evaluates indirect prompt injection in tool-using agents [3], motivating tests that place malicious content in untrusted observations and then verify external tool boundaries. CYBERSECEVAL 3 examines multiple cybersecurity capability and risk dimensions [4], underscoring the need to distinguish successful task completion from containment and misuse resistance. None of these references establishes that our system outperforms existing systems; direct comparison would require matched tasks, budgets and reproducible baselines.

## 3. System

Windows/Linux Go agents export allowlisted, sanitized state over mutual TLS. Stable identity is separate from configuration archetype grouping. Neo4j preserves observed, inferred and confirmed relationship types, and PostgreSQL stores run history. The Phase 2 planner enumerates a bounded directed candidate universe and applies a greedy coverage/resource heuristic. It is not an exact minimum vertex-cut algorithm. Dependency services must coexist in a wave before a path-specific test can validate supported behavior.

Four pinned service adapters render Nginx, PostgreSQL, Redis and OpenSSH into synthetic accounts and data. Unsupported versions/directives fail visibly. A dedicated Linux worker applies per-run network policy and container limits; Docker internal networking is one control, not an air-gap guarantee. Docker Desktop supports local behavior smoke checks but does not exercise the required Linux host policy.

TwinHunter receives sanitized state and asks for typed configuration inspection, scanning, curated Nuclei, constrained HTTP/TCP/database tests, deterministic security checks or candidate patch verification. The executor validates targets, ports, methods, DNS results and redirects, and applies independent rate, deadline, step and token limits. Model text can introduce a hypothesis; only executed tool observations can supply confirmed findings. Evidence identifies source snapshots, image IDs, executed test versions and fidelity limitations. The optional remote model is contacted by the control plane, never by testing workloads.

## 4. Remediation

The verifier applies indexed configuration edits to a deep copy of a source scenario. Original and candidate twins execute the original security test and representative legitimate workflows. Syntax and startup checks are prerequisites, not substitutes for compatibility checks. The artifact retains both snapshot IDs, a diff, rollback configuration, image identifiers, observations and limitations. Acceptance is labeled “verified in the tested twin scenario.” We do not infer production compatibility or zero downtime from these checks.

## 5. Experimental design

The declared 20-scenario set contains four scenarios per core service, two proxy chains and two deliberate exclusions. A separate wire-client implementation verifies proposed labels before scoring. The oracle and system are maintained by the same project, so external review and a larger held-out set are required. The fixtures are policy conditions, not a representative CVE corpus. For example, synthetic password login measures configured authentication behavior; it does not establish production password weakness.

Four methods share the scenario set and declared sandbox budget: static configuration/version rules, default twins, synchronized deterministic twins and synchronized TwinHunter. Missing model access remains as unavailable rows. Ground-truth labels and scenario descriptions are withheld from model state. Default-twin policies are explicitly specified rather than assumed to represent every vendor default. Resource measurements use sampled memory, cumulative CPU and integrated memory-time. The protocol also declares a four-service scheduling subset, a separately labeled 100-node synthetic graph, and an optional full-VM subset. Details and denominators are in `PROTOCOL.md`.

## 6. Measured results

The authoritative measured tables and plots are generated from `results/repeated/report.json` by `analyze.py` and saved in `results/repeated/results.md`, `summary.json`, and PNG/SVG plots. The earlier pilot remains in `results/local`. Both raw datasets retain unsuccessful and unsupported rows. The initial supported subset has nine positive and nine negative labels, all independently wire-verified. Static rules and synchronized deterministic twins classify the small supported fixture set equally well, while policy-default twins produce three true positives, three false positives, six true negatives and six false negatives. This supports configuration sensitivity within the fixtures and does **not** establish an improvement over static assessment.

The seeded Redis authentication change passes security and legitimate SET/GET checks; an invalid Redis directive fails startup; an unchanged exposure remains reproducible; a PostgreSQL reject rule blocks the legitimate query and is rejected as a regression. These four controls test verifier logic rather than estimating general remediation effectiveness.

The corrected two-repetition run retains 160 declared rows: 108 completed static/deterministic cases, 12 unsupported cases and 40 unavailable AI cases. Conclusive predictions were consistent across both repetitions. The AI method has no measured precision, F1, token consumption or cost until the pinned model is hosted and the isolated Linux run executes. No model output, graph size, or synthetic fixture count is represented as a physically instrumented deployment.

The three-repetition four-service scheduling subset measured mean CPU totals of 1.063 seconds for selective scheduling and 2.048 seconds for always-on containers; integrated memory was 51.572 versus 389.233 MB-seconds, respectively. Mean sampled peak memory was 14.969 versus 25.542 MB. These are narrow lifecycle measurements under a declared 20-second always-on horizon, not general fleet savings. Raw repetitions, standard deviations and plots are in `results/scheduling.json`, `results/scheduling-results.md`, and `results/scheduling-cost.png`. Full-VM measurements remain explicitly absent.

## 7. Limitations and threats to validity

The fixture set is small and intentionally simple, with repeated patterns within services. Static rules can solve the supported conditions, so the present suite cannot demonstrate added AI discovery value. Additional held-out, configuration-sensitive scenarios are needed without tuning labels to the proposed system. The adapters cover limited syntax and identity/network semantics; omissions can invalidate source-to-twin extrapolation. The PostgreSQL twin uses a local-only synthetic bootstrap rule, recorded as a fidelity limitation.

Docker Desktop observations do not certify host/LAN/internet containment. Boundary tests cover declared adversarial requests, not all possible prompt injection. GPU reproducibility depends on actual hardware, serving framework, dtype, context, quantization and seeds. Colab allocations are variable and an 80 GB GPU is not guaranteed by a subscription description. Sampling may miss transient resource peaks. Agent overhead, synchronization latency, real billing, stochastic AI variability and VM cost are not filled with estimates when unmeasured.

## 8. Reproducibility and responsible scope

`docs/phase3.md` supplies setup commands; `scenarios.json` fixes the declared set; the model lock pins the selected open-weight revision and serving profile. Reports contain manifest hashes, image IDs, hardware, budgets, independent labels, traces, raw observations, patch artifacts and exclusions. Test targets are registered disposable twins with synthetic data. There is no unrestricted shell or automatic patching of original hosts. This draft makes no publication or performance guarantees.

## References

1. Yao et al. *ReAct: Synergizing Reasoning and Acting in Language Models*. ICLR 2023. https://arxiv.org/abs/2210.03629
2. Deng et al. *PentestGPT: Evaluating and Harnessing Large Language Models for Automated Penetration Testing*. USENIX Security 2024. https://www.usenix.org/conference/usenixsecurity24/presentation/deng
3. Debenedetti et al. *AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents*. NeurIPS Datasets and Benchmarks 2024. https://arxiv.org/abs/2406.13352
4. Bhatt et al. *CYBERSECEVAL 3: Advancing the Evaluation of Cybersecurity Risks and Capabilities in Large Language Models*. 2024. https://arxiv.org/abs/2408.01605
5. Qwen. *Qwen3.5-27B model card*. https://huggingface.co/Qwen/Qwen3.5-27B
6. Google. *Colab FAQ: resource limits and availability*. https://research.google.com/colaboratory/faq.html
