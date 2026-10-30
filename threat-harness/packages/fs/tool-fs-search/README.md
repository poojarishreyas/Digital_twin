---
description: "The model-facing glob and grep discovery tools for users and maintainers composing or debugging workspace search for agents."
kind: "package-reference"
---

# @elemental/tool-fs-search

## Summary

`tool-fs-search` provides the model-facing filesystem discovery tools — `glob` and `grep` — backed by a packaged ripgrep binary, so no host `rg` install and no filesystem backend are needed. Each call runs ripgrep itself with a fixed argument set and returns workdir-relative results, and the tools are always available because every carrier packages ripgrep. Results are bounded by configurable caps, and a capped result is saved in full through the optional spill store when one is mounted. Choose this package when the model should discover files by pattern or search file contents; text file reading, writing, and editing are the sibling `tool-fs` package's job.

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

Mount the tools after a `ctx.subprocess` backend; no host `rg` install is needed, and no filesystem provider is required. The model then gets modification-time-ordered file discovery and line-oriented content search, each bounded and timeout-guarded.

### Minimal composition

A subprocess backend, then the tools; the spill backend is optional and makes capped results fully recoverable.

```yaml
- name: '@elemental/subprocess-local'
- name: '@elemental/tool-fs-search'
  config:
    sampleOverCapGlobResults: false
- name: '@elemental/spill-local'
```

`sampleOverCapGlobResults` is required and has no fallback: deployments choose the over-cap ordering contract explicitly. When formatted spill succeeds, both modes preserve the complete sorted list in the spill artifact.

### The tools

| Tool | Arguments | Behavior |
|---|---|---|
| `glob` | `pattern`, `path?` | Finds files whose paths match a glob pattern, including hidden and ignored files but excluding VCS metadata; a pattern with no `/` matches basenames at any depth, so `*` matches the whole tree; complete results stay modification-time ordered |
| `grep` | `pattern`, `path?`, `include?`, `type?`, `ignore_case?`, `output?`, `context?`, `before_context?`, `after_context?`, `head_limit?`, `offset?` | Searches file contents with a ripgrep regex and returns the matching files with a match count each, or with `output: "lines"` the matches grouped by file as `Line N: <preview>`, under the signature of the declaration that contains them ([grep pages](#grep-pages)). `include` is one positive glob filter, with comma-separated lists and negated values rejected up front; `type` is one ripgrep file type; context lines are allowed only with `output: "lines"`, from 0 to `grepMaxContextLines` |

Routine budgets stay out of the model-facing schema: a model that needs surrounding context reads the matched file with `read`, and one that needs later results follows the returned spill locator's retrieval hint.

### Configuration

`sampleOverCapGlobResults` is required; the remaining keys are optional search caps with the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `sampleOverCapGlobResults` | none (required) | `true` samples an over-cap `glob` page across top-level entries; `false` keeps the modification-time-ordered head |
| `globMaxResults` | `100` | Max paths one `glob` call shows inline |
| `grepMaxMatches` | `250` | Largest accepted `head_limit`; a `lines` call whose matches go past its page saves the complete list to the formatted spill artifact |
| `grepDefaultHeadLimit` | `100` | Files or matches one `grep` page shows when the call omits `head_limit`; at most `grepMaxMatches` take effect |
| `grepMaxContextLines` | `5` | Largest accepted `context`, `before_context`, or `after_context` |
| `grepAnnotateScopes` | `true` | Whether a `lines` page groups matches under the declaration that contains them |
| `grepScopeMaxFileBytes` | `1048576` | Matched files at least this large are not parsed for enclosing declarations |
| `grepMaxLineBytes` | `2000` | Byte cap per matched-line preview, preserving UTF-8 boundaries |
| `rawOutputMaxBytes` | `20000000` | Max complete raw `rg` stdout a search will parse; larger raw output fails with `SEARCH_RAW_OUTPUT_OVERFLOW` |
| `timeoutMs` | `30000` | Cooperative tool-call budget on both tools, enforced through `exec.signal` |
| `graceMs` | `3000` | Terminate-escalation grace the subprocess seam grants past `timeoutMs` |
| `stderrMaxBytes` | `65536` | Diagnostic-tail budget for `rg` stderr |
| `searchMetaMaxBytes` | `65536` | Max bytes of one search's serialized `presentationMeta`; trailing groups/paths drop past it |

The generated [configuration catalog](../../../docs/config-catalog.md#elementaltool-fs-search) is the exhaustive source for every accepted field and its JSDoc.

<a id="grep-pages"></a>
### grep pages, context, and enclosing declarations

Both output modes page: `head_limit` sets how many files (default output) or matches (`output: "lines"`) one call shows, and `offset` skips that many. A page with more after it ends with `(Showing files 1-100 of 431. Use offset=100 to see the next page, …)`. A later page's header reads `Found 431 matches; showing 101-200`. An offset past the end says how many there were.

With `output: "lines"`, `context`, `before_context`, and `after_context` ask ripgrep for surrounding lines. Context lines read `Line N- <text>`, matches read `Line N: <text>`, and `--` separates runs that are not adjacent. Only context near a match on the shown page is shown.

When `grepAnnotateScopes` is on and a filesystem service (`ctx.fs`) is mounted, each matched file on the page is read and parsed with the tree-sitter grammars that [`tool-fs`](../tool-fs/README.md#folded-reads) bundles. Matches are grouped under the innermost named declaration that contains them:

```text
src/grep.ts
[L112 in executeGrep: export async function executeGrep(opts: GrepOpts) {]
Line 142:   return results.slice(0, limit)
[L180 in Store.add: add(item: Thing): void {]
Line 184:     this.items.push(item)
[outside any declaration]
Line 201: const limit = 10
```

The header names the declaration's dotted path and its signature line. Files in languages without a bundled grammar, files of `grepScopeMaxFileBytes` or more, and files that cannot be read show their matches without headers. The result value carries the headers' declarations as `scopes` and any context lines as `context`, beside the complete `matches`.

### Deployment requirement

Node deployments receive the `@vscode/ripgrep` platform package on supported macOS, Linux, and Windows targets; Python SDK wheels copy the target-native binary beside the single-file runtime as a `-rg` sidecar. No carrier requires a host `rg`. Returned paths are displayed relative to the resolved workdir (the calling session's cwd when present) and are follow-up-readable with `read` only when that workdir and the filesystem root are the same workspace.

### Failures and recovery

Search failures carry the package-owned codes `SEARCH_INVALID_PATTERN` (ripgrep rejected the regex or glob), `SEARCH_FAILED` (a failed launch, inaccessible target, signal kill, or malformed `--json` output), `SEARCH_RAW_OUTPUT_OVERFLOW` (raw output over the cap), and `SEARCH_ABORTED` (cooperative timeout or caller cancellation). Exit 0 is success with results and exit 1 is a successful empty search; model argument mistakes stay ordinary tool argument errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the search tools and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

Local workspace discovery is naturally a process-backed `rg` workflow, and putting search on `ctx.fs` would force every filesystem backend to grow a search API. The subprocess seam owns spawn execution, process-tree termination, environment scrubbing, and bounded output capture; this package owns schemas, argument validation, argv construction, parsing, retention, formatted-result spill, and timeout declaration. The tools never expose a background job — the call returns only after `rg` exits, is terminated by the cooperative timeout, is aborted, or fails.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, tool composition, cap validation |
| [`src/glob.ts`](src/glob.ts) | `glob` schema, argv, parsing, inline sampling, formatting |
| [`src/grep.ts`](src/grep.ts) | `grep` schema, argv, `--json` parsing, paging, context lines, enclosing-declaration headers, preview retention, formatting |
| [`src/search-core.ts`](src/search-core.ts) | Shared spawn helper, `SEARCH_*` errors, spill handoff, workdir-relative display |
| [`src/presentation.ts`](src/presentation.ts) | Search-card metadata projection |
| [`src/direct-call.ts`](src/direct-call.ts) | Direct-call result acceptance for spill post-processing |

### How a search runs

Each call resolves the packaged binary (`@vscode/ripgrep`, or the executable's `-rg` sidecar in a pkg single-file runtime), prepends `--no-config` so a host `RIPGREP_CONFIG_PATH` cannot inject a `--pre` preprocessor into the unconfined spawn, and passes every model-controlled value as a plain argv element — no shell layer exists, so no quoting applies. Collect-mode budgets bound complete stdout and a stderr tail; a lossy stdout read fails as `SEARCH_RAW_OUTPUT_OVERFLOW` rather than parsing a silently-partial stream. The tools never read a raw spill path.

### Two budgets, two artifacts

Raw stdout and stderr are internal transport details; the tools always collect the complete result in memory, and only the inline page is capped. When a call yields more logical results than the inline cap, a best-effort spill saves the complete formatted preview to the spill store and the page carries its locator, while dispatches whose full value never enters model context skip the spill. Missing or failed spill keeps the inline page and reports that the complete result could not be saved — never an error. The collection and spill handoff live in `src/search-core.ts` and `src/presentation.ts`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools to the subprocess seam, the spill store, and the filesystem family.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [tool-fs](../tool-fs/README.md) — the sibling `read`/`write`/`edit` tools for follow-up reads.
- [Subprocess capability](../../../docs/subsystems/subprocess.md) — the spawn seam these tools execute through.
- [Spill store](../../spill/spill/README.md) — the optional backend that makes capped results fully recoverable.
- [Timeout utility](../../util/timeout/README.md) — the `MAX_TIMER_DELAY_MS` bound on the terminate grace.
- [Generated tool catalog](../../../docs/tool-catalog.md#elementaltool-fs-search) — the exhaustive schemas this package registers.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the independently registered glob and grep guidance below. Agent-scoped tool restrictions can hide either schema without removing its prompt section.

##### Glob guidance with `sampleOverCapGlobResults: true`

```markdown
Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, while a larger one is sampled across top-level entries, so it spans the tree instead of one subtree.
```

##### Glob guidance with `sampleOverCapGlobResults: false`

```markdown
Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, while a larger one keeps the modification-time-ordered head.
```

##### Grep guidance

```markdown
Use the grep tool — not shell grep or rg — to search file contents. It lists matching files by default; pass output "lines" only when the matching lines themselves answer the question, with context for a few lines around each match. Matching lines are grouped under the signature of the function, method, or class that contains them. Use read on a matched file when you need more.
```

#### Token effect

Fixed guidance cost per request while the tools are registered; the required sampling choice selects one glob variant.

#### KV Cache effect

Prefix-stable while the plugin scope, sampling choice, and guidance text are unchanged. Activation, disposal, or changing the choice may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The glob description states the configured over-cap ordering. The generated [`glob` and `grep` schemas](../../../docs/tool-catalog.md#elementaltool-fs-search) use `sampleOverCapGlobResults: true`; the tools are registered unconditionally.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results and spill notices

#### What the model sees

`glob` returns one path per line. `grep` returns a found-count header and one `<path> (<count>)` line per matching file by default; a file list longer than its page ends with the page range and the next `offset`, and is not spilled. With `output: "lines"`, `grep` groups `Line <line>: <preview>` matches beneath each path and, when it can parse the file, beneath `[L<line> in <name>: <signature>]` headers, with `Line <line>- <text>` context lines when asked for. Empty searches return `No files found` or `No matches found`. A capped `glob` or `lines` result ends with its omission count plus the spill locator and backend retrieval hint, or says the complete result could not be saved. With `sampleOverCapGlobResults: true`, an over-cap `glob` page takes paths round-robin across entries immediately beneath the actual search root, and the footer states the sampled basis and how many top-level entries it reached; with `false`, the page is the modification-time-ordered head and keeps the plain capped-result footer. The spill artifact always holds the complete list in modification-time order.

#### Token effect

Inline paths and matches are bounded by `globMaxResults`, the `grep` page size (`head_limit`, default `grepDefaultHeadLimit`), and `grepMaxLineBytes`. A declaration header costs one line per change of enclosing declaration and usually saves the `read` the model would otherwise make to learn where a match sits; the call and retained result remain in history until compaction. With [`compaction-tool-result-pruner`](../../compaction/compaction-tool-result-pruner/README.md#superseded-results) mounted, a `grep` or `glob` result is superseded once the same tool succeeds again with identical arguments, so at the next fold only the latest copy stays in full.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>` with structured `SEARCH_INVALID_PATTERN`, `SEARCH_FAILED`, `SEARCH_RAW_OUTPUT_OVERFLOW`, or `SEARCH_ABORTED` metadata for callers. `grep` argument mistakes are ordinary tool argument errors with these messages: `type must be one ripgrep file type name, e.g. "ts" or "py"`, `<field> must be an integer from 0 to <grepMaxContextLines>`, `context lines apply only to output "lines"`, `head_limit must be an integer from 1 to <grepMaxMatches>`, and `offset must be a non-negative integer`. An unknown `type` is rejected by ripgrep and reported as `SEARCH_FAILED`.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the search tools are a poor fit or need special operational care. They are current package constraints, not a general search comparison or a task backlog.

- **Search and file access have no shared-workspace proof** — returned paths are follow-up-readable only when the workdir and filesystem root denote the same workspace; the package performs no runtime cross-service validation.
- **The packaged binary is fixed at dependency version** — Node deployments use the version selected by `@vscode/ripgrep`; Python single-file runtimes copy that target-native version into the required `-rg` sidecar. An unsupported platform or a corrupted installation fails with `SEARCH_FAILED`, while the Python runtime package rejects a missing sidecar before launch. Remote or virtual filesystems need a co-located workspace or another search consumer.
- **The schemas expose one bounded page** — offset pagination, case-mode switches, alternate output modes, and provider-backed discovery remain outside this package; capped complete output requires a spill backend.
- **Sampling, when enabled, groups by first path segment beneath the search root only** — an over-cap `glob` page balances across those top-level entries, so a result concentrated deeper is still shown unevenly below that level; recursive balancing is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
