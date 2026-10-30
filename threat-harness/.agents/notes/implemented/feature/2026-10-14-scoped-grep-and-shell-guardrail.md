# Agent Note: grep pages with context and declaration headers, and bare shell reads are capped

Status: implemented

## Problem

`grep` already listed matching files with per-file counts by default, but it had none of the options a model reaches for next. It could not ignore case, filter by ripgrep file type, show context lines, or page past its cap. A model that needed any of these ran `rg` or `grep` in `bash`. That output bypassed the search caps, the read ledger that answers repeat reads, and the 8 KB shell spill preview only partly bounded it.

`grep` lines also came back flat: `142: return results.slice(0, limit)` says nothing about which function holds line 142. The model then read the file only to find the enclosing function.

The same bypass applied to reading. A bare `cat` printed a whole file into context with no line numbers and no read record, and the next `edit` of that file still failed the read-before-edit guard.

## Decision

**`grep` parameters and pages.** `grep` gains these parameters, alongside the default file list with counts:

- `ignore_case`: `--ignore-case`.
- `type`: one ripgrep file type name.
- `context`, `before_context`, `after_context`: 0 to `grepMaxContextLines` (default 5), allowed only with `output: "lines"`. The one-sided values override `context`.
- `head_limit`: 1 to `grepMaxMatches` (250); defaults to `grepDefaultHeadLimit` (100).
- `offset`: files or matches to skip.

Both output modes page. A page with more after it names the next offset, and a later page's header shows its range. A `lines` call with matches past its page still saves the complete list to a spill file. Context lines read `Line N- text`, and `--` separates runs that are not adjacent. Only context near a match on the shown page is shown. The parameter is still called `include`, not the design sketch's `glob`, because the existing name is in recorded sessions and the user's in-progress grep work.

**Enclosing-declaration headers.** With `grepAnnotateScopes` on (the default) and `ctx.fs` mounted, each matched file on a `lines` page is read and parsed with the tree-sitter grammars `tool-fs` bundles. Matches are grouped under `[L<line> in <dotted name>: <signature line>]`, and `[outside any declaration]` marks a return to top level. `tool-fs` exports `declarationScopes` and `innermostScope` for this; `listDeclarations` now also records each declaration's own signature line. Files in other languages, files of `grepScopeMaxFileBytes` (1 MiB) or more, and unreadable files show their matches without headers. The result value carries `context` and `scopes` beside the complete `matches`.

**Shell guardrail.** `shell` gains `bareCommand(command, dialect)` and `capBareOutput(text, command, maxBytes)`. A bare command is a single simple command whose name is a file reader or a search:

- bash: `cat`, `head`, `tail`, `rg`, `grep`, `egrep`, `fgrep`, `find`. Leading `NAME=value` assignments are skipped.
- pwsh, case-insensitive: `Get-Content`, `gc`, `cat`, `type`, `Select-String`, `sls`, `Get-ChildItem`, `gci`, `dir`, `ls`.

A command is not bare if it has, outside quotes, a pipeline, a list, a redirection, a substitution, a subshell or script block, or a `find` action such as `-exec` or `-delete`. `tool-bash` and `tool-pwsh` gain `bareCommandMaxBytes` (default `0`, off). When it is set, a bare command's rendered output keeps whole lines up to the cap and its trailing status markers, plus one notice naming the `read`, `grep`, or `glob` tool for the job. `base` sets it to 4096.

**Target configuration mapped onto existing plugins.** The design's configuration block is not this repository's `cordis.patch.yml` format, so each key became a plugin config field:

- `shell.spill` is spill-policy's `toolPolicies` for `bash`, `pwsh`, and `job_output`, from the shell-digest note.
- `interceptBareSearchAndRead` is `bareCommandMaxBytes: 4096` on both shell tools.
- `grep.*` is `grepMaxMatches` (250), `grepDefaultHeadLimit` (100), `grepMaxLineBytes` (2000), `grepMaxContextLines` (5), and `grepAnnotateScopes` (true). The new grep keys are set explicitly in `base`.
- `glob.*` already matched: `globMaxResults` 100, modification-time order, and top-level sampling (left off in `base`, as before).
- `read.*` already matched: `readLimit`, `readMaxBytes`, `readMaxLineLength`, and `readFoldMinLines`.
- `fsObservationPolicy.*` already matched: read-before-edit, unchanged-read pointers, and deltas from the read-ledger note. `agent-instructions` already loads nested `AGENTS.md` and `CLAUDE.md` files when a read, write, or edit reaches their folder.
- `edit.shadowDiagnostics` is the edit-shadow-check note.
- `sessionSearch.openAt` is now `after-compaction` in `base` and the web bundle, as the design asks. This supersedes the opt-in decision in [Session content search ships opt-in through openAt never](../architecture/2026-08-13-session-content-search-opt-in.md) for the shipped default. SQLite still is not imported at startup, so the startup compat test keeps its no-warning assertion and now pins `after-compaction`.

## Alternatives considered

**Route a bare shell command through the native tool, translating its arguments, as the design sketch proposed.** Rejected. Translating `grep -rn --include=*.ts -e x src` or `find . -name '*.ts' -newer y` faithfully means reimplementing each tool's flag language. A wrong translation silently returns different results from the command the model wrote. Capping keeps the command's own output, bounds its cost, and teaches the right tool in the same result.

**Block bare commands before they run.** Rejected because it costs a turn even when the output is small and harmless. The cap costs nothing below 4 KB.

**Heuristic function-header detection instead of tree-sitter.** Rejected because the grammars are already bundled for folded reads. A regex over `function`/`def`/`fn` misses methods, arrow functions, and nesting, and cannot name `Store.add`.

**Compute declaration headers for every match.** Rejected: only the shown page is parsed, so a 5,000-match search reads at most the page's files.

**The design's compaction settings (`strategy: epoch_pinned`, `minUncachedTokensBeforeFold`, `emitSemanticTombstones`).** Not adopted, for the reasons in [Folds rewrite history only when the prompt cache is already lost](2026-10-14-cache-pinned-folds.md). An uncached-tail trigger folds tokens that were about to become cache hits. Model-written tombstones need a model call per fold, and nothing can check their claims. The pressure fold with a minimum gain, cache-cold folds, and superseded markers cover the same goals.

## Consequences

- One `grep` call now covers what used to take a shell `rg` with flags or a follow-up `read` to find the enclosing function. On this repository, a `lines` search with declaration headers over six matches in four files took about 120 ms including parsing.
- A header costs one line per change of enclosing declaration on the page.
- The default `grep` page shrinks from 250 to 100 files or matches. Recorded sessions whose searches return more than 100 files or matches, or that use the old over-cap footer wording, need a snapshot refresh. The `grep` schema and prompt text change too.
- `tool-fs-search` now peer-depends on `tool-fs` and `fs`. It reads matched files through `ctx.fs` only for headers, and only when that service is mounted.
- A bare `cat` of a large file now shows 4 KB and a pointer to `read`. A model that pipes or redirects keeps full output under the shell spill policy.
- After the first compaction in a process, the Web sidebar's content search opens at the next search, and the in-memory index imports `node:sqlite` then. Before that, sidebar search behaves as under `never`. The model-facing session search tools remain unmounted in the shipped bundles, so the model gains nothing from this until a deployment mounts them.

## Related

- [Shell output spills at 8 KB with its failures listed, and read can outline a file](2026-10-14-shell-digest-and-outline.md): the shell spill caps the guardrail sits under.
- [A per-session read ledger answers repeat reads with pointers and deltas](2026-10-14-read-ledger.md): what a shell `cat` bypasses.
- [Folded reads keep a file's outline around the requested code](2026-10-14-folded-reads.md): the grammars and declaration list the headers reuse.
