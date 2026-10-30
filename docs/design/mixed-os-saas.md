# Multi-company SaaS design for Windows and Linux twins

Status: proposed architecture, not an implemented Windows execution backend. The current service adapter catalog targets linux/amd64. The existing Windows and Linux discovery paths do not imply that every discovered asset can be reproduced for execution.

## Decision

Keep one tenant-scoped inventory and graph model. Select the execution environment for each test from a versioned capability catalog. Use separate Linux and Windows execution pools, plus an optional customer-hosted pool. TwinHunter remains a control-plane service and uses a common typed tool interface; operating-system behavior belongs in adapters and runtime backends.

An employee laptop can appear in the graph without starting a VM. Start an executable environment only when a declared test needs one. A reconstructed service or policy environment is a bounded reproduction, not a full clone of the employee's laptop.

## Three levels of customer coverage

| Level | Customer receives | Requirement |
| --- | --- | --- |
| Discovered | Assets, configuration evidence, connections, freshness and gaps | Enrolled native collector with sufficient permissions |
| Assessed | Explicit configuration or topology checks | A validated assessment rule and sufficient source evidence |
| Reproduced and tested | Executed observations from a disposable environment | A compatible adapter, runtime, dependencies and passing isolation checks |

Record these dimensions independently. An asset can be discovered and assessed while executable coverage is unsupported. Unavailable workers are a capacity problem, not proof that the source is unsupported. A failed isolation check blocks execution and is not a safe finding.

## Customer collection and snapshot model

Use native Windows and Linux agents. Agents establish outbound authenticated telemetry connections. Enrollment credentials bind each agent to one active tenant and asset identity; do not trust a caller-supplied tenant identifier for attribution.

Normalize asset and service identity, OS family, product/edition, version/build, patch evidence, CPU architecture, service version, configuration hashes, collection permissions, timestamps and dependency evidence. Preserve native configuration syntax and order alongside normalized fields. Windows registry and ACL semantics must not be flattened into Linux equivalents. New Windows collectors for effective firewall policy, local permissions or Group Policy require explicit implementation and verification; do not advertise them merely because the graph can store them.

Each test consumes immutable source snapshot identifiers. If a required collector is missing, the identity mapping is unresolved, or policy is stale, record the gap before admission. Updating telemetry creates a new source revision; it does not silently change a running test.

## Execution selection

| Tested behavior | Proposed runtime | Important boundary |
| --- | --- | --- |
| Existing supported Linux service policies | Linux containers inside an isolated disposable job VM | Same adapter/version restrictions as today |
| A service collected from Windows | Windows runtime by default; Linux only after explicit cross-OS conformance validation for that exact test | Same protocol or product name does not establish equivalent behavior |
| Supported IIS or other Windows Server service behavior | Compatible Windows Server VM; optionally validated Windows containers within it | Add and validate an adapter before offering coverage |
| Windows client permissions, desktop applications or OS-specific endpoint behavior | Compatible Windows client VM or customer-controlled test environment | Windows Server is not a substitute for a Windows employee laptop |
| Active Directory-dependent behavior | Isolated synthetic Windows domain lab with required member machines | Never join a testing environment to the customer's production domain |
| Unknown build, architecture, configuration or dependency semantics | No executable job | Retain graph coverage and explain the unsupported test scope |

Windows container host/image compatibility is version-dependent. Desktop GUI applications and Active Directory Domain Services are not a general Windows-container workload. Use VMs where the test depends on these features. Validate product and deployment licensing before enabling a particular image; an employee's Windows license does not automatically authorize a hosted replica.

Every adapter declares source compatibility, required runtime OS/build/architecture, image identity, supported configuration grammar, identity/dependency needs, available tests, fidelity exclusions, legitimate-workflow checks and cleanup/isolation contract version. A Linux adapter may not silently accept Windows-origin configuration.

The planner applies this admission order:

1. Derive tenant, authorization and requested test scope from trusted application state.
2. Check snapshot freshness, collection completeness and adapter compatibility.
3. Resolve the full dependency bundle, OS builds and architecture requirements.
4. Select a provider-hosted or customer-hosted execution location allowed by the tenant's data policy.
5. Reserve compute, model budget and a job-specific isolation boundary.
6. Verify allowed paths and blocked destinations before making target tools available.
7. Execute bounded actions; store evidence and verify cleanup before retiring the lease.

Separate statuses include unsupported, stale, awaiting-capacity, isolation-failed, inconclusive and completed. Report the reason and next available action in the dashboard.

## Runtime abstraction and TwinHunter

Introduce a proposed RuntimeBackend contract for environment creation, image attestation, configuration rendering, dependency networking, readiness, registered probe execution, isolation verification, evidence collection and destruction. Linux and Windows backends implement this contract separately. The Windows implementation uses Windows-compatible controls and probes; it does not invoke Linux iptables or assume BusyBox and Linux filesystem semantics.

Expose tools through the existing validated target/port/action model. Map each action to an adapter-owned probe implementation with structured output, enforced deadlines and output bounds. Add an OS-specific typed action only with a defined schema and executor checks. Do not expose arbitrary PowerShell or shell execution to the model. Existing Linux-oriented ToolExecutor and Lab assumptions require refactoring and Windows conformance tests before this interface is production-ready.

TwinHunter cannot choose another tenant, assign itself a different execution pool, introduce a production target, or change a job's source snapshot. Only expose tools supported by that job's backend. Carry tenant and job identity through requests, evidence, traces, caches and model conversations. Gemini receives only approved sanitized context through the control plane; untrusted test machines do not receive model credentials.

## Tenant and network boundaries

Use a fresh VM boundary for each concurrent tenant job. Its service containers and dependency machines belong to that one job. Do not use container labels or separate directories as the only boundary between hostile multi-company workloads. Destroy the job VM after use; any later reuse requires a verified rebuild from an approved clean image, not in-place tenant switching.

Keep API/database/model-control networks separate from execution networks. Test workloads receive no management credentials or route to production, other tenants, cloud metadata, worker management endpoints or arbitrary internet destinations. Model/network policy is enforced externally, not through prompts. Image installation and package acquisition occur during controlled image preparation, not through unrestricted runtime egress.

For mixed Windows/Linux dependency tests, place compatible machines in one isolated tenant job network and allow only declared service edges. Keep management traffic on a separate authenticated path. Use synthetic users, domains, credentials and application records. If those substitutions cannot preserve a test's semantics, return a fidelity gap rather than a production validation claim.

The optional private worker uses the same capability, tenant and job contracts. It initiates outbound authenticated communication and executes only in an approved isolated test network. A private worker is not permission to probe production or expose the customer's network to other tenants. Data-residency policy separately controls whether snapshots or model context may leave that location.

## AWS deployment recommendation

Run the SaaS API, dashboard, inventory, queue and TwinHunter control plane on managed application infrastructure. Keep the existing privileged Docker/host-firewall execution path on separately managed Linux EC2 workers; it is not a drop-in Fargate task. Use Windows EC2 VMs for the initial Windows execution backend. Consider Windows container orchestration only after service compatibility, host/image matching and isolation are validated.

Provision approved VM templates on demand with tenant concurrency limits, hard job deadlines, resource budgets and cleanup reconciliation. Keep Windows capacity demand-driven initially; measure boot time and cost before adding warm pools. Customer-hosted Windows client environments are an option where hosted licensing, residency or fidelity cannot be satisfied. This design intentionally makes no instance-price or OS-license entitlement assumption.

## Rollout in this repository

1. Add the capability catalog, source OS/build/architecture evidence and explicit coverage states. Preserve existing Linux benchmark behavior and historical report identity. Reject Windows-origin execution unless an adapter explicitly supports it.
2. Extract runtime-specific behavior from `phase3/runtime.py`, `phase3/tools.py` and the Phase 2 engine into a backend interface. Keep control-plane and tenant checks shared. Require the same isolation evidence contract for both backends.
3. Add one bounded Windows Server adapter, such as a declared IIS configuration behavior, on disposable VMs. Test positive/negative controls, legitimate workflows, image/build identity and cleanup before expanding the catalog.
4. Add selected Windows endpoint behaviors on actual supported Windows client environments. Treat inventory, configuration assessment and executed endpoint evidence as separate capabilities.
5. Add multi-machine domain/dependency labs and private workers only after single-runtime isolation, attribution and lifecycle handling pass acceptance.

Acceptance must exercise wrong-OS/build rejection, supported and unsupported configuration, unavailable capacity, cross-tenant job/result access, model context isolation, forbidden network paths with reachable positive controls, interrupted jobs, failed cleanup and source changes during an active test. A clean result in one OS/runtime does not upgrade coverage on another. No production infrastructure or benchmark data was changed to create this design.

## Sources

- [Microsoft Windows container version compatibility](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/version-compatibility)
- [Microsoft guidance on workloads that cannot move to Windows containers](https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/lift-shift-to-containers)
- [AWS ECS shared responsibility and EC2 task isolation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-shared-model.html)
- [AWS Fargate task definition limitations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html)
- [AWS guidance on bringing licensed images to EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/dedicated-hosts-BYOL.html)

Diagram: [Mixed OS SaaS architecture](mixed-os-saas.html). The diagram shows component relationships; returned evidence follows the authenticated job channel into tenant-scoped storage. Worker functionality is proposed, not a claim of an implemented Windows backend.
