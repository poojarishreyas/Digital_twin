---
description: "The model-facing read, read_image, write, and edit tools for users and maintainers composing or debugging filesystem access for agents."
kind: "package-reference"
---

# @elemental/tool-fs

## Summary

`tool-fs` provides the model-facing filesystem tools — `read`, `read_image`, `write`, and `edit` — and their executor. With them the model reads files with line numbers, creates or replaces them atomically, and applies targeted literal edits; results are capped and failures carry stable codes with recovery instructions, all backed by a mounted `ctx.fs` backend. The read-before-edit policy lives in a separate plugin (`fs-observation-policy`), so omitting it yields unconditional, still-atomic mutations. `read_image` appears while a durable attachment store is mounted and refuses execution unless the routed model declares image input. Choose this package when the model should read, create, replace, or edit UTF-8 text files; discovery (`glob`/`grep`) is a sibling package.

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

Mount the tools after a `ctx.fs` backend and, for read-before-write/edit behavior, the policy plugin. The model then gets line-numbered reads, atomic writes and edits, and — with an attachment store mounted — image reads; every result is capped, and failures carry stable codes with recovery instructions.

### Minimal composition

A backend, the policy plugin, then the tools; the attachment store is optional and enables `read_image`.

```yaml
- name: '@elemental/fs-local'
- name: '@elemental/fs-observation-policy'
- name: '@elemental/tool-fs'
```

The policy plugin is optional: without it the tools run against the bare provider (unconditional write, overwrite, and edit with no observed-state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit. `read_image` registers only while a durable `ctx.attachments` service is mounted; execution additionally refuses on a route whose exact model does not declare image input, so a text route's durable history stays free of image blocks.

### The tools

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?`, `symbol?`, `fold?`, `outline?` | Line-numbered UTF-8 content with a pagination footer; `offset` is 1-based and `limit` defaults to and caps at the configured `readLimit`. In a TypeScript, JavaScript, Python, Go, Rust, or Java file, a `symbol` read, an `outline` read, and an `offset`/`limit` read of a file with at least `readFoldMinLines` lines return a [folded view](#folded-reads). A repeat read can return a pointer or a delta instead ([read ledger](#read-ledger)) |
| `read_image` | `file_path` | Reads and persists a PNG/JPEG/WebP/GIF source; an extension-less path (normalized attachment object paths included) is identified from its file signature; normalization can downscale it before the next model request, so the model need not create a thumbnail first |
| `write` | `file_path`, `content` | Creates or fully replaces a file; with the policy plugin, overwriting requires a prior `read` at the unchanged version, creating does not. Reports the syntax errors the new content introduced ([edit syntax check](#edit-syntax-check)) |
| `edit` | `file_path`, `old_string`, `new_string`, `replace_all?` | Literal replacement requiring a unique match unless `replace_all` is true; with the policy plugin, requires a prior `read` and an unchanged file, and a file changed since that read fails with the changes shown ([read ledger](#read-ledger)). Reports the syntax errors the edit introduced ([edit syntax check](#edit-syntax-check)) |

Field names are snake_case to match Claude Code and existing harness tool schemas. Successes return compact envelopes — a read window, an image reference, or a `Created file`/`Updated file` confirmation — and `write`/`edit` derive replayable diff-card metadata for UI presentation.

### Configuration

All keys are optional; the defaults are the shipped read caps.

| Key | Default | Meaning |
|---|---|---|
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call |
| `readMaxLineLength` | `2000` | Characters kept per line before truncation |
| `readMaxBytes` | `51200` | Byte cap on one `read` call's selected lines; overflow ends the window with a capped footer |
| `readStreamMinSize` | `10485760` | Files at or above this size (or of unknown size) stream instead of loading whole into memory |
| `readFoldWindows` | `true` | Whether an `offset`/`limit` read of a long source file returns a folded view; `symbol` reads fold regardless |
| `readFoldMinLines` | `400` | Line count at or above which an `offset`/`limit` read of a source file folds |
| `editSyntaxCheck` | `true` | Whether `edit` and `write` parse the changed file and report the syntax errors the change introduced |
| `editSyntaxMaxListed` | `3` | How many introduced syntax errors one result lists before counting the rest |

The generated [configuration catalog](../../../docs/config-catalog.md#elementaltool-fs) is the exhaustive source for every accepted field and its JSDoc.

<a id="folded-reads"></a>
### Folded reads

A folded view parses the file with a bundled tree-sitter grammar (`grammars/`, loaded on first use) and shows the requested declaration or lines in full. Everything outside the focus stays visible except function bodies and long comments: each function, method, or closure body outside the focus is replaced by one `⋯ [L<start>-L<end> folded: <n> lines]` marker between its signature line and its closing line, and each comment or docstring run of three or more lines keeps only its first line with words. Imports, type and interface declarations, class fields, and module constants are never folded. Visible lines keep their real line numbers, so `edit` can target them directly and a later `offset`/`limit` read can open any folded span.

`symbol` names a declaration by its dotted path (`Store.add`) or by its last segment (`add` matches every `*.add` when no top-level `add` exists); the focus includes the declaration's `export`/`const` wrapper and its leading comments, decorators, and attributes. `fold: false` returns raw lines instead: with `symbol`, just the declaration's lines. A read falls back to the plain line window when the folded view would exceed `readMaxBytes`, when nothing outside the focus folds, when a `symbol` declaration alone exceeds `readLimit` lines (paged from its first line), or — for an `offset`/`limit` read only — when the grammar cannot load. Files that stream (`readStreamMinSize`) never fold, and a `symbol` read of one fails.

`outline: true` folds every function body and long comment in the file, with nothing in focus, so the model can see what a file declares before choosing a `symbol` or a range. It cannot be combined with `symbol`, `offset`, `limit`, or `fold: false`. An outline has no plain fallback: an unsupported language, a streamed file, or an outline above `readMaxBytes` fails with a message that says what to read instead. Its structured value also lists `declarations`, each a dotted `name` with its `start` and `end` lines, so a `run_code` program can choose what to read next without parsing the text.

<a id="edit-syntax-check"></a>
### Edit syntax check

After every successful `edit` or `write` of a file in a bundled grammar's language, the tool parses the new text with the same tree-sitter grammars that serve folded reads and lists the syntax errors the change introduced. Each error is a missing token the parser had to insert (`missing "}"`) or text it could not place (`unexpected "<first 40 characters>"`), on the line where the parser noticed it. Errors the file already had before the change do not count. They are matched by message, so an unrelated edit to a file with a known error stays quiet, and the old text is parsed only when the new text has errors. A new file has no earlier errors. The result value gains `syntaxErrors` (`{ line, message }[]`), and the confirmation gains one line:

```text
The file /abs/src/auth.ts has been updated successfully.
[Shadow check: this change introduced 1 syntax error. L49: missing "}". Fix it before editing other files or building.]
```

At most `editSyntaxMaxListed` errors (default 3) are listed; the rest are counted. The check is best-effort and never fails the change, which has already landed. It skips files in other languages and files of `readStreamMinSize` bytes or more, and reports nothing when the grammar cannot load. Parsing takes from under a millisecond to a few tens of milliseconds per file once a grammar is loaded. Set `editSyntaxCheck: false` to turn it off. Type and lint errors need a real checker; [`edit-check`](../edit-check/README.md) runs one within a deadline and reports in the same place.

<a id="read-ledger"></a>
### Read ledger

With [`fs-observation-policy`](../fs-observation-policy/README.md) mounted, every model-direct `read` of an in-memory file records what it showed for the calling session: the file text, the lines shown in full (a line cut at `readMaxLineLength` does not count), and the result itself as evidence. The next read of that file consults the record, but only while every evidence result is still on the session surface with its text intact; a result the compaction pruner trimmed, the spill policy replaced, or a summary absorbed makes the next read a full read.

- **Unchanged.** When the file text is identical and every line the read would show was already seen, the result is a one-line `file_unchanged` pointer instead of the lines.
- **Changed.** When the file changed — by the model's own `edit`, a formatter, a hook, or another process — and every unchanged line the read would show was already seen, the result is a `file_delta`: only the changed regions, each with two lines of context, numbered by current lines. The delta is used only when it is shorter than the full read and needs at most as many changed lines as the read would show; otherwise the read is full. The delta becomes evidence too, so the read after it can be a pointer.
- **Stale edit.** When `edit` fails with `FS_STALE_VERSION` because the file changed since the last read, and the record still holds, the failure lists the changes in the same delta form and marks the file read at its current version, so retrying the same `edit` succeeds without another `read`. If the record does not hold, the change exceeds `readLimit` lines or `readMaxBytes`, the file streams, or it changes again while the failure is built, the failure keeps the generic re-read remedy.

`run_code` sub-calls, calls without an agent, and streamed files are neither recalled nor recorded; they always read in full.

### Policy and sandbox behavior

Path authorization for `read` and `read_image` belongs entirely to `ctx.fs`; media-type declarations and file signatures only decide whether `read_image` accepts the bytes returned by that backend.

With the policy plugin mounted, `write` and `edit` obtain their guard from the `fs/*` intent slots, so an unread target or a stale observation fails with `FS_NOT_OBSERVED` or `FS_STALE_VERSION` and a recovery instruction. Under a confining backend (`fs-sandbox`), `write`/`edit` additionally advertise `sandbox_permissions` and `justification`; a denied mutation returns the `[sandbox: file access denied under <mode> mode]` marker with the same-turn escalation hint, and an approved retry may stamp a strictly wider mode for that one call.

### Failures and recovery

Failures are normalized as `Error: <message>` with a structured code preserved for callers. Stable messages include `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, and the image-route refusal `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`. Guarded-mutation failures append their remedy: `FS_STALE_VERSION` gets `— re-read the file, then retry`, `FS_NOT_OBSERVED` gets `— read the file, then retry`. After the reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool suite and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The tools are the executor; policy is an event gate. The tools inject no policy service and inspect no cache — each mutation asks the single intent slot for its guard through `ctx.waterfall`, and each operation emits `fs/observed` only after it succeeded. Reads do exactly one provider `stat` (type and size routing plus the observed version); mutations do none, because the guard comes from the intent slot and the provider re-checks under its lock.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, tool composition, `read_image` attachments gate |
| [`src/read.ts`](src/read.ts) | `read` executor: one stat, streaming decision, window build, observation |
| [`src/read-image.ts`](src/read-image.ts) | `read_image` executor: route and media-type gates, bounded bytes, attachment save |
| [`src/write.ts`](src/write.ts) | `write` executor: intent waterfall, atomic write, observation |
| [`src/edit.ts`](src/edit.ts) | `edit` executor: intent waterfall, literal edit, observation |
| [`src/read-render.ts`](src/read-render.ts) | Cordis-free windowing and envelope formatting, plain and folded |
| [`src/read-elastic.ts`](src/read-elastic.ts) | Decides between a plain window and a folded view; resolves `symbol`; plans an outline |
| [`src/read-fold.ts`](src/read-fold.ts) | Pure fold planning and declaration lookup over a parsed syntax tree |
| [`src/read-syntax.ts`](src/read-syntax.ts) | Lazy `web-tree-sitter` runtime and per-grammar parsers over `grammars/*.wasm` |
| [`src/read-recall.ts`](src/read-recall.ts) | Read ledger decisions: evidence check on the session surface, unchanged/delta/full, knowledge to record |
| [`src/line-diff.ts`](src/line-diff.ts) | Bounded Myers line diff and unified hunks for deltas |
| [`src/stale-edit.ts`](src/stale-edit.ts) | Stale-edit failure that shows the changes and refreshes the observed version |
| [`src/sandbox.ts`](src/sandbox.ts) | Escalation API shared by `write`/`edit`: policy resolution and denial-marker mapping |
| [`src/error.ts`](src/error.ts) | Model-facing remedy appended to `FS_STALE_VERSION` and `FS_NOT_OBSERVED` |

### Per-tool flow

All four tools share one flow shape: resolve the path with the calling session's cwd, run the applicable gate, perform exactly one provider operation, and emit `fs/observed` only after success. `read` and `read_image` pay one `stat` for type and size routing; `write` and `edit` pay none because their guard comes from the intent slot, and provider failures surface as typed `FsError` results. The per-tool executors live in `src/read.ts`, `src/read-image.ts`, `src/write.ts`, and `src/edit.ts`.

### Observation and concurrency

`fs/observed` fires after the operation succeeded via a plain `ctx.emit`; a listener is contractually a synchronous, side-effect-only recorder, so async or fallible observation does not belong on this event. `read` opts into concurrent scheduling because its only mutation is the synchronous version recorder; recorder races fail closed when a later `write` or `edit` re-checks the version under its target lock, and both mutation tools remain exclusive.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tools to the contract, backends, and policy they compose with.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [fs](../fs/README.md) — the `ctx.fs` contract these tools consume.
- [fs-local](../fs-local/README.md) — the host-filesystem backend these tools run against.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend that adds the escalation fields.
- [fs-observation-policy](../fs-observation-policy/README.md) — the policy plugin that guards mutations through the `fs/*` events.
- [Generated tool catalog](../../../docs/tool-catalog.md#elementaltool-fs) — the exhaustive schemas this package registers.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope receives the independently registered read, write, and edit guidance below. Scoped tool restrictions can hide schemas without removing these sections.

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files. To work on one function, method, or class in a source file, read it by symbol: you get that declaration in full plus the file's imports, types, and signatures, with other bodies folded to their line spans. To see what a source file declares before choosing what to read, read it with outline=true.
```

##### Write guidance

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.
```

##### Edit guidance

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token effect

Fixed guidance cost per request while the plugin is active, even when a restriction hides one or more tools.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Tool restrictions do not remove this section, but plugin activation or disposal may invalidate reuse from it.

### Tool schemas

#### What the model sees

The model sees the generated [`read`, `read_image`, `write`, and `edit` schemas](../../../docs/tool-catalog.md#elementaltool-fs), with snake_case arguments. The image tool appears only while a durable attachment store is mounted; its schema is route-independent, and the strict gate refuses at execution. Scoped tool restrictions can remove any definition for one agent.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Read result

#### What the model sees

A successful read is exactly `<path><displayPath></path>`, newline, `<type>file</type>`, newline, `<content>`, numbered lines as `<lineNumber>: <text>`, a blank line, one footer, and `</content>`. The footer is exactly `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`, `(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)`, or `(End of file - total <total> lines)`. A long line ends exactly `... (line truncated to <max> chars)`. A [folded view](#folded-reads) uses the same envelope with a `⋯ [L<start>-L<end> folded: <n> lines]` line in place of each folded span and the footer `(Folded view of <total> lines: <focus> shown in full; <hidden> lines in <count> folded regions. Each folded region keeps its line span; read it with offset and limit, or pass fold=false for raw lines.)`, where `<focus>` is `lines <spans>` or `<symbol> (lines <spans>)`. An outline's footer is `(Outline of <total> lines: <hidden> lines in <count> folded regions. Read a declaration in full with symbol, or a folded region with offset and limit.)`. A [ledger](#read-ledger) pointer is exactly `[file_unchanged: <path> L<start>-L<end> are identical to your earlier read, which is still in this conversation. Use that output; nothing was re-sent.]`, or names `the lines you were shown between L<first> and L<last>` when the read shows several spans. A delta is `[file_delta: <path> changed since your earlier read (<old total> → <new total> lines). Only the changed regions follow, numbered by current lines; the rest of what you read is unchanged.]` followed by unified hunks: a `@@ -<old start>,<old count> +<new start>,<new count> @@` header, then one line per entry as ` <n>: <text>` (unchanged, current number), `-<n>: <text>` (removed, old number), or `+<n>: <text>` (added, current number). A missing read still returns `FS_NOT_FOUND`, but it records confirmed absence for the calling session; after an externally deleted file is re-read, a retried `write` can safely recreate it through the provider's no-replace guard.

#### Token effect

Read output is capped by `readLimit`, `readMaxLineLength`, and `readMaxBytes`; the retained call and result are resent until compaction. A `symbol` read of a large file costs a fraction of the whole file: measured on 1,900–4,100-line TypeScript, Python, and Go files, 20–43% of the whole-file tokens (about 5,800–11,800 tokens). An `offset`/`limit` read that folds costs more than the bare window, because the outline of the rest of the file rides along: a 60-line window of the same files grew from about 600–1,000 tokens to 6,600–12,700. Set `readFoldWindows: false` to keep windowed reads bare. An outline costs about what a `symbol` read costs minus the declaration: 20% of the whole file for a 3,100-line analyzer and 23% for a 3,600-line client fixture module, but 42% for a 1,900-line module whose types and doc comments make up much of it. A file that is mostly data, such as a generated catalog, has nothing to fold, so its outline costs as much as reading it whole. A ledger pointer costs about 40 tokens where a repeat full read of a 1,900-line file costs about 24,600; after a formatter inserts an import and rewraps one statement, the delta costs about 130–170 tokens. Knowledge is checked against the surface on every read, so the savings stop when compaction removes the earlier result. With [`compaction-tool-result-pruner`](../../compaction/compaction-tool-result-pruner/README.md#superseded-results) mounted, a `read` result is superseded by a later identical `read` that returned file content (not a pointer or delta), or by a successful `write` of the same path, and collapses to a one-line marker at the next fold. A full re-read that showed every line the reader knew becomes its only evidence, so superseding the older read keeps the ledger valid.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Image read result

#### What the model sees

A successful `read_image` returns `<path><displayPath></path>`, `<type>image</type>`, and a `<content>` envelope naming the media type, normalized dimensions, and byte size, followed by the image itself as a native image block. The result is logged with its durable reference before the next model request.

#### Token effect

The image is billed on every later request until compaction. Each call is independently bounded by the attachment store's `maxImageBytes`/`maxImagePixels`/`maxImageDimension`; repeated successful calls accumulate history, and content addressing deduplicates only the stored bytes, not the per-request token cost.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Write and edit results

#### What the model sees

Write returns the exact five-line envelope `<path><displayPath></path>`, `<type>file</type>`, `<content>`, `Created file` or `Updated file`, then `</content>`. Edit returns exactly `The file <displayPath> has been updated successfully.` or, for `replace_all`, `The file <displayPath> has been updated. All occurrences were successfully replaced.` The full write or replacement text remains in the assistant tool-call arguments.

#### Token effect

Success text is small, but large mutation arguments and any result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable validation and read messages are `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `symbol must be a non-empty string`, `pass either symbol or offset/limit, not both`, `symbol "<symbol>" was not found in "<path>"; declared symbols: <names>.` (at most 40 names, then `… (<n> more)`; `it declares no named symbols` when there are none), `symbol focus is not available for "<path>": it supports <extensions> files. Use offset and limit instead.`, `symbol focus needs the whole file in memory, and "<path>" is <size>. Use offset and limit instead.`, `outline reads the whole file; do not combine it with symbol, offset, or limit`, `outline is a folded view; do not combine it with fold=false`, `an outline is not available for "<path>": it supports <extensions> files. Use offset and limit instead.`, `an outline needs the whole file in memory, and "<path>" is <size>. Use offset and limit instead.`, `the outline of "<path>" is <bytes> bytes, above the <max>-byte read cap. Read a declaration with symbol, or a range with offset and limit.`, `old_string must be a non-empty string`, `old_string and new_string must differ`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, `offset <offset> is out of range for "<path>" (<total> lines)`, `cannot read "<path>": the <ext> extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`, `cannot read "<path>": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`, `cannot read "<path>": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`, `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`, and the mismatch repair `cannot read "<path>": the <ext> extension declares <type>, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats` (an extension-less mismatch reports `cannot read "<path>": the file signature claims <type>, but the bytes decode as a different image format; the file may be corrupt`). A failed 16-bit conversion reports `cannot read "<path>": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`. Provider and policy templates are quoted in their package READMEs. A stale edit that the [read ledger](#read-ledger) can bridge fails with `FS_STALE_VERSION` and exactly `"<path>" changed since your last read, so the edit was not applied. The changes, numbered by current lines (everything else you read is unchanged):`, the delta hunks, and `You now have the current content: retry the edit against it.`; a rewrite that left the content identical reports `"<path>" was rewritten since your last read but its content is identical, so the edit was not applied. Retry it as is.` Other guarded-mutation failures additionally carry their recovery instruction in the message, appended by this package's model-facing error wrapper: `FS_STALE_VERSION` gets `— re-read the file, then retry`, and `FS_NOT_OBSERVED` gets `— read the file, then retry`; the structured code is preserved. After that reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool suite is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- **No model-facing directory listing ships** — `ctx.fs.listDir` serves provider code such as skill discovery, while the sibling `tool-fs-search` package supplies ripgrep-backed `glob` and `grep` rather than extending the filesystem seam.
- **`read` handles UTF-8 text files only** — images use the separate `read_image` tool; PDF, audio, and video remain deferred. A directory target is `FS_NOT_REGULAR_FILE`.
- **The read ledger lives in memory** — a resumed session, a new plugin instance, or a reader whose earlier result was compacted away gets full reads again; knowledge is never persisted.
- **Folding covers seven grammars** — TypeScript, TSX, JavaScript, Python, Go, Rust, and Java ship as WASM files in `grammars/` (about 5.5 MB); other languages read plainly and reject `symbol` and `outline`. A repeated folded read of the same file resends its outline; deduplicating repeated observations belongs to the observation ledger, not this package.
- **Extension-declared media type** — an extension selects the declared type and the attachment store's magic-byte validation stays authoritative; a correctly formatted image under a wrong extension is refused with the rename remedy rather than sniffed. Only a path with no extension is identified from its file signature.
- **Object paths re-enter source admission** — `read_image` on a normalized attachment object re-admits its bytes as a new source, so a deployment whose `maxImageBytes`/`maxMessageImageBytes` sit below the normalized-image byte budget can refuse an object path that `ctx.attachments.readImage` still serves; shipped defaults keep the normalized budget (4 MiB) far under the source caps (20 MiB).
- **No inline image preview on the tool-result card** — UI surfaces render the image result generically (the durable reference, not pixels); inline rendering is deferred to the UI packages.
- **No attachment-region tool** — an agent may crop an image through another available tool when it has a filesystem path; a pasted or dragged image without a path cannot be re-read at higher resolution.
- **No timeout surface** — `read`/`write`/`edit` take no timeout argument and declare no timeout budget; cancellation rides `exec.signal` only ([provider rationale](../README.md)).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
