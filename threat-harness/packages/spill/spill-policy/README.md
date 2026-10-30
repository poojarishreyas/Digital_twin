---
description: "The tool-result spill policy: how deployments keep oversized plain-text tool results out of the model's context with a preview and a retrievable spill file."
kind: "package-reference"
---

# @elemental/spill-policy

## Summary

`spill-policy` keeps oversized plain-text tool results out of the model's context: when a final result exceeds `maxInlineBytes`, it saves the full text through `ctx.spillStore` and replaces the model-facing result with a bounded head/tail preview plus the backend's locator and retrieval guidance, which the model can use to read or grep the spill file. Per-tool policies can lower the cap for one tool and reserve part of its preview for error, failure, and stack-frame lines from the omitted middle, each numbered by its line in the spill file. It registers no service and owns no storage or preview mechanics — storage is the mounted `SpillStore` backend and previews come from `output-retention`; it only decides when to spill and composes the notice. It is opt-in and best-effort: omitted `maxInlineBytes` disables it entirely, and a spill failure leaves the original result visible. A second arm applies the same cap to the durable log copy of `run_code` sub-call results, so replay and UIs never grow unbounded either.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the policy alongside a spill backend to cap how much of a tool's plain-text result the model sees. The cap applies to final results after the tool has run; results the policy leaves alone still pass through unchanged.

### Minimal configuration

Load the policy with a `maxInlineBytes` budget, in UTF-8 bytes, and a spill backend:

```yaml
- name: '@elemental/spill-local'
- name: '@elemental/spill-policy'
  config:
    maxInlineBytes: 50000
    previewBytes: 2000
```

| Field | Default | Meaning |
|---|---|---|
| `maxInlineBytes` | omitted | Spill a plain-text result larger than this many UTF-8 bytes; omitted disables the policy entirely |
| `previewBytes` | `maxInlineBytes` | UTF-8 size of the replacement — preview plus notice — for a spilled result; at most `maxInlineBytes` |
| `diagnosticBytes` | `0` | UTF-8 bytes of the preview reserved for omitted lines that match `diagnosticPattern`; at most `previewBytes`; `0` keeps a plain head/tail preview |
| `diagnosticPattern` | `(error\|ERR!\|FAIL\|Exception\|panic:\|at .*\.[tj]sx?:\d+)` | Case-insensitive regular expression a diagnostic line matches |
| `toolPolicies` | `{}` | Per-tool `maxInlineBytes`, `previewBytes`, and `diagnosticBytes`, keyed by tool name; omitted fields inherit the top-level values, shrunk to fit the tool's own limits |

`base` ships `maxInlineBytes: 50000` and `previewBytes: 2000`, matching Claude Code's 50,000-character cap and 2,000-character preview: a result over 50 KB costs about 500 tokens in context instead of about 12,500, and the model reads the file for anything the preview does not show. Shell output spills earlier. `bash`, `pwsh`, and `job_output` use `maxInlineBytes: 8192`, `previewBytes: 2560`, and `diagnosticBytes: 512`, so a 40 KB test log costs about 640 tokens instead of about 10,000, and its failures stay visible. A patch that replaces this row's config replaces these tool policies too, and without `previewBytes` it returns to a full-budget preview.

The generated [configuration catalog](../../../docs/config-catalog.md#elementalspill-policy) is the exhaustive source for every accepted field. A negative or fractional value, or a `previewBytes` above `maxInlineBytes`, fails plugin load rather than corrupting per-call behavior.

### What the model sees

An oversized plain-text result is replaced by a preview plus a notice inside the same budget, so the whole replacement never exceeds `previewBytes`:

```text
<retained head/tail preview>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

With a diagnostic budget, the head and tail each end on a whole line, and the matching lines from the omitted middle sit between them:

```text
<head lines>

[Matching lines from the omitted middle; numbers are lines in the stored file:]
L181:  FAIL tests/unit/auth.spec.ts > login > rejects a bad token
L182: AssertionError: expected 401 to be 200
L184:     at Object.<anonymous> (src/auth.ts:88:11)

<tail lines>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-bash.txt. …)
```

Lines are listed in order until the next one does not fit. A line too long to fit whole is cut to start 40 characters before its match, with `…` marking each cut. When no omitted line matches, the head and tail share the whole preview, as without a diagnostic budget.

When the notice alone fills the budget (a tiny cap or a long locator), the preview is empty and only the notice is returned; if even that would exceed the cap, the policy keeps the original inline result — a within-cap replacement is always smaller than the original. The full text stays available in the spill file, and a successful replacement changes only the model-facing copy, never the canonical programmatic result.

### Which results are affected

The policy shapes only final, accepted, plain-text results. Results at or below the cap, results containing any non-text block, nested composite calls, `read` results, blocked decisions, and accepted value replacements all pass through unchanged. Provider-level truncation that already happened (for example `web-fetch-http.maxBodyChars`) cannot be recovered here — the spill file holds what the tool actually returned.

### Best-effort failure behavior

A missing session owner, a missing `ctx.spillStore` backend, or a `saveText` rejection logs a warning and returns the original result. A spill failure never turns a successful call into an error and never hides the inline result.

### The durable log copy

The same cap also bounds the session-log copy of each `run_code` sub-call result: the program still receives the complete value, only the log's copy is replaced with the preview and locator. Oversized `read` sub-call results are bounded here too, since a log copy is not model context.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the policy; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The policy is deliberately narrow: it only decides **when** to spill and composes the notice. It registers no service, owns no storage, and owns no preview mechanics — `TextRetainer` from `output-retention` builds the head/tail preview. Two invariants shape the code: the model-facing replacement never exceeds `previewBytes` (the notice's byte cost is reserved out of the budget first, and the diagnostic section's fixed lines out of `diagnosticBytes`), and a spill failure never changes the tool call's outcome. Because `previewBytes` is at most `maxInlineBytes` and only larger results spill, a replacement is always smaller than the original.

### The two arms

A `tools/post-execute` waterfall listener (registered with `prepend`, delegating via `next()`) bounds the model-facing result; a `tools/ptc-dispatch-log` listener bounds the durable log copy of each `run_code` sub-call. Both share one replacement helper so the two projections are byte-identical. The post-execute arm skips `read` to avoid a read → spill → read loop; the dispatch-log arm bounds `read` sub-calls because a log copy is not model context.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` validation, per-tool limit resolution, the two waterfall listeners, the shared replacement helper |
| [`src/digest.ts`](src/digest.ts) | Preview builder: the plain head/tail preview and the diagnostic form that lists matching middle lines by line number |
| [`src/types.ts`](src/types.ts) | `SpillPolicyExec`: the minimal structural view of a tool execution the policy reads for the owning session id |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; contracts are enforced at the seam) |

### Failure modes

Best-effort degradation applies to both arms: no session owner, no backend, a save rejection, or no within-cap replacement logs a warning and keeps the original content. Load-time validation rejects a negative or fractional `maxInlineBytes`; a `previewBytes` that is negative, fractional, or above `maxInlineBytes`; a `diagnosticBytes` that is negative, fractional, or above `previewBytes`; a `diagnosticPattern` that does not compile; and `toolPolicies` without a top-level `maxInlineBytes`. Each tool policy is checked the same way after inheritance, and its error names the tool, so a bad config fails the deployment, not every oversized call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Spill storage service](../spill/README.md) — the `saveText` contract behind the policy's replacement.
- [spill-local](../spill-local/README.md) — the local backend that stores the spilled text.
- [output-retention](../../util/output-retention/README.md) — the preview mechanics (`TextRetainer`) the policy composes.
- [Tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary and design rationale.
- [PTC dispatch-log spill decision](../../../.agents/notes/implemented/feature/2026-07-26-ptc-dispatch-log-spill.md) — why the durable log copy is bounded too.

-----

<a id="model-experience"></a>
## Model Experience

### Oversized plain-text result

#### What the model sees

Results at or below the tool's `maxInlineBytes`, nested results, `read` results, blocked decisions, and results containing non-text blocks are unchanged. An oversized plain-text model-facing result becomes a bounded head/tail preview followed by `(Omitted <bytes> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`; a storage or ownership failure leaves the original result visible. For a tool with a diagnostic budget, the preview also lists `L<n>: <line>` entries for omitted lines that match `diagnosticPattern`, under `[Matching lines from the omitted middle; numbers are lines in the stored file:]`, so the model can read around a failure with `read` `offset`/`limit` on the stored file without searching it first.

#### Token effect

A successful replacement is at most `previewBytes` UTF-8 bytes (2,000 in `base`, roughly 500 tokens; 2,560 for shell output, roughly 640 tokens) and remains in history until compaction; the full spill text is not resent to the model. Reading the spill file back costs whatever the model reads.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the policy cannot help. They are current package constraints.

- **Only final plain-text results are spillable** — mixed-content results, blocked feedback, and `read` pass through; provider truncation or tool-owned retention that happened earlier cannot be recovered here.
- **A notice that cannot fit disables replacement for that call** — a tiny cap or long locator leaves the oversized original inline after the backend has already saved an unreferenced spill.
- **Diagnostic lines are matched by pattern, not parsed** — a failure that prints no line matching `diagnosticPattern` (a vitest `❯ file:line` frame, a bare assertion diff) is visible only through the head, the tail, or the stored file. A pattern broad enough to catch more also lists more noise, such as passing test names that contain "error".

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: tool-declared policies

`toolPolicies` is deployment configuration keyed by tool name. A tool that knows its output shape, such as a test runner, could declare its own diagnostic pattern instead; that waits for a second tool with a different shape. The built-in `read` skip stays hard-coded because it prevents a loop, not a size.

#### Future: earlier spill

The policy only sees final formatted text, so content already capped by a provider or held only as runtime artifacts (for example bash streams or subagent rollouts) stays out of reach; tool-owned early spill through `ctx.spillStore` is deferred.

</details>
