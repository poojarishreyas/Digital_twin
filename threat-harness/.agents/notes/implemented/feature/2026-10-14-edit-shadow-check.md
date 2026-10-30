# Agent Note: Edits report syntax errors and checker diagnostics on the step that made them

Status: implemented

## Problem

`edit` and `write` confirmed every change with "updated successfully", whatever the change did to the file. A model that dropped a closing brace in one file went on to edit two more. It found the mistake only when it ran a build in `bash`. By then, one missing token had become a wall of cascading compiler errors spread over several files. Untangling them cost a build-and-debug loop of several turns and thousands of tokens. Claude Code and Codex have the same gap: neither checks an edit before reporting it applied.

## Decision

Two layers report problems in the result of the change that caused them.

**Syntax check in `tool-fs`, on by default.** After a successful `edit` or `write`, the tool parses the new text with the tree-sitter grammars it already ships for folded reads, and collects every missing node (`missing "}"`) and error node (`unexpected "<first 40 characters>"`). If the new text has any, the old text is parsed too. Problems are matched by message, because lines move with every edit. Each problem the old text already had cancels one identical problem in the new text. What remains was introduced by the change. The result value gains `syntaxErrors`, and the confirmation gains one line:

```text
[Shadow check: this change introduced 1 syntax error. L49: missing "}". Fix it before editing other files or building.]
```

At most `editSyntaxMaxListed` (default 3) are listed. `editSyntaxCheck: false` turns the check off. Files in other languages and files of `readStreamMinSize` bytes or more are skipped. Read, write, and edit share one set of parsers.

**Checker plugin `edit-check`, opt-in.** A `tools/post-execute` listener runs a deployment-configured checker for the file's extension through `ctx.subprocess` under one deadline (`timeoutMs`, default 500 ms). It appends `[Shadow check (<checker>): this change introduced <n> diagnostic(s). …]` to the final text block. A checker that reads stdin (`ruff`, `eslint --stdin`, `biome`) runs on the text before and after the change in parallel, and only new diagnostics are reported. A checker that reads the file on disk runs once, after the change, and is compared with its previous result for the same file; the first check of a file reports every diagnostic, worded as the file's state. Diagnostics are parsed from `file:line[:col]: message` and `file(line,col): message` lines whose file resolves to the checked one. Only model-direct results are checked: a `run_code` program receives the value, never this text.

Both layers are best-effort. A grammar that fails to load, a missing executable, a deadline, an abort, or unparsable output adds nothing. The change has already landed, so a check never turns it into an error.

## Alternatives considered

**`tsc --noEmit --incremental` and `cargo check` as default checkers, as the design sketch proposed.** Rejected as defaults. Both check the whole project. On anything but a small project they rarely finish in 500 ms, and a check that usually times out reports nothing while adding its deadline to every edit. They are possible as on-disk checkers with a raised `timeoutMs`. Fast per-file type checks need a long-lived language service, which is recorded as future work in the `edit-check` README.

**Ship a configured checker in `base`.** Rejected: no checker is installed everywhere, and an unresolvable command would only log a warning. Deployments that know their toolchain configure one.

**Run the checker inside `edit` and `write`.** Rejected because `tool-fs` does not depend on `ctx.subprocess` and should not run commands to confirm a file change. A separate plugin on the existing post-execute seam keeps the tools free of process management and lets the checker cover other tools that return the same value shape.

**Block the edit, or roll it back, when it introduces errors.** Rejected. Intermediate states are often broken on purpose: a model adds an opening line in one edit and its body in the next. Reporting keeps the model in control and costs one line.

**Match problems by line number.** Rejected, because every edit above a problem moves it. Message matching misses one case, a change that fixes one problem and introduces an identical one elsewhere. That case is rare compared with every edit that moves lines.

## Consequences

- A syntax error is reported on the step that introduced it, for about 30–60 tokens. A build is no longer the first place the model learns of it. Parsing adds from under a millisecond to a few tens of milliseconds per change once the grammar is loaded.
- Tree-sitter grammars accept some invalid code: a mismatched JSX closing tag passes, for example. They report the line where the parser noticed a problem, which can be after the real mistake, such as a missing `}` reported at the end of the function. The notice is a pointer to look, not a compiler diagnostic.
- With `ruff` configured as a stdin checker, a checked edit took 10–20 ms end to end in testing. The notice listed the two undefined names the change introduced and left out an unused import the file already had.
- The `edit` and `write` result schemas gain `syntaxErrors`. Recorded sessions whose edits introduce syntax errors need a snapshot refresh.
- `edit-check` is a new workspace package: `pnpm install` must update the lockfile, and the generated module, event, and API catalogs must be regenerated.

## Related

- [Folded reads keep a file's outline around the requested code](2026-10-14-folded-reads.md): the grammars and parsers the syntax check reuses.
- [Shell output spills at 8 KB with its failures listed, and read can outline a file](2026-10-14-shell-digest-and-outline.md): the previous step in cutting the build-and-debug loop.
