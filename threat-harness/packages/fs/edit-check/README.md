---
description: "The post-edit shadow check: how deployments run a fast linter or type checker on each edited file and show the model the diagnostics its change introduced."
kind: "package-reference"
---

# @elemental/edit-check

## Summary

`edit-check` runs a configured checker, such as `ruff` or `eslint`, on each file the model changes with `edit` or `write`. It appends the diagnostics the change introduced to that tool result, so the model fixes them on its next step instead of finding them in a build several edits later. Checkers are deployment configuration, never model input, and run through `ctx.subprocess` within a strict deadline (500 ms by default). It registers no service. It is opt-in and best-effort: without configured checkers it registers nothing, and a missing executable, a deadline, or unparsable output leaves the result as the tool returned it. `tool-fs` runs its own tree-sitter syntax check on every change, with no external tool; this package adds whatever a real linter or type checker can catch in the same budget.

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

Mount the plugin after the tool registry and a subprocess runtime, and name a checker per file extension.

### Minimal configuration

```yaml
- name: '@elemental/edit-check'
  config:
    checkers:
      ruff:
        extensions: ['.py', '.pyi']
        command: ruff
        args: ['check', '--quiet', '--output-format=concise', '--stdin-filename', '{path}', '-']
        stdin: true
```

| Field | Default | Meaning |
|---|---|---|
| `checkers` | `{}` | Checkers by name. Each lists `extensions` (with the dot, matched case-insensitively), a `command` (absolute path or bare `PATH` name), `args` (`{path}` becomes the file's absolute path), and `stdin` |
| `checkers.<name>.stdin` | `false` | `true` feeds the file's text on stdin and checks the text before and after the change; `false` lets the checker read the file on disk after the change |
| `timeoutMs` | `500` | Wall-clock budget for one check, both runs of a stdin checker included |
| `maxListed` | `3` | Diagnostics a notice lists before counting the rest |
| `maxOutputBytes` | `65536` | Bytes of stdout and of stderr kept from one run |
| `graceMs` | `100` | Time a timed-out checker gets to exit after termination |
| `tools` | `['edit', 'write']` | Tools whose results are checked; each must return the `{ path, before, after }` value `edit` and `write` return |

The generated [configuration catalog](../../../docs/config-catalog.md#elementaledit-check) is the exhaustive source for every accepted field. An extension without a leading dot, an extension two checkers claim, a checker with no extensions, or a non-positive limit fails plugin load.

### Choosing a checker

A checker earns its place when it answers for one file in well under the budget. Good fits:

- **`stdin: true`**: linters that read source on stdin, such as `ruff check --stdin-filename {path} -`, `eslint --stdin --stdin-filename {path} --format unix`, or `biome lint --stdin-file-path={path}`. The checker runs on the text before and after the change, and only new diagnostics are reported.
- **`stdin: false`**: tools that must read the file, such as `go vet` or a project script. The checker reads the file on disk after the change. Its previous result for the same file is the baseline. The first check of a file reports every diagnostic, worded as the file's state rather than as new.

Whole-project type checks (`tsc --noEmit`, `cargo check`) rarely finish in 500 ms. Configure them only with a raised `timeoutMs` on projects small enough to fit, or rely on the build.

### Which results are checked

Only accepted, model-direct results of the configured tools whose value has a string `path` and `after`. `run_code` sub-calls are skipped, because the program receives the value and never this text. Failed results, blocked decisions, and value replacements pass through unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

A `tools/post-execute` listener delegates with `next()` first, so hooks settle the result before the check, and then appends the notice to the final text block of the accepted content. The checker runs with the session's working directory as its cwd. Each checker's executable is resolved once through `ctx.subprocess.resolveExecutable`; a failure disables that checker with one warning. One deadline signal combines the call's abort signal with `timeoutMs`, and both runs of a stdin checker run in parallel under it.

Diagnostics are lines of combined stdout and stderr in the form `file(line,col): message` (tsc) or `file:line[:col]: message` (ruff, eslint's unix format, gcc, go vet, `cargo --message-format=short`) whose file resolves to the checked file. `-`, `<stdin>`, and `stdin` also name it. Lines move with every edit, so diagnostics are compared by message: each earlier diagnostic cancels one identical message after the change.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config validation, executable resolution, checker runs, the post-execute listener |
| [`src/diagnostics.ts`](src/diagnostics.ts) | Output parsing, introduced-diagnostic comparison, and the notice |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant) |

### Failure modes

A run that times out, is aborted, is killed by a signal, or cannot start reports nothing. For a stdin checker, a failed run on either side reports nothing, because there is no comparison to make. Output beyond `maxOutputBytes` is not parsed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [tool-fs](../tool-fs/README.md#edit-syntax-check) — the built-in tree-sitter syntax check on every `edit` and `write`.
- [subprocess](../../subprocess/subprocess/README.md) — the process seam checkers run through.
- [Edits report syntax errors and checker diagnostics on the step that made them](../../../.agents/notes/implemented/feature/2026-10-14-edit-shadow-check.md) — the design decision.

-----

<a id="model-experience"></a>
## Model Experience

### Checked edit or write

#### What the model sees

When a checker finds new diagnostics, the tool's confirmation gains one line: `[Shadow check (<checker>): this change introduced <n> diagnostic(s). L<line>: <message>; … and <k> more.]`. For an on-disk checker seeing a file for the first time it reads `[Shadow check (<checker>): the file has <n> diagnostic(s) after this change. …]`. Nothing is added when the check finds nothing new or cannot run.

#### Token effect

A notice costs about 20–60 tokens per listed diagnostic and is resent until compaction. It replaces a build or lint run in `bash`, whose output usually costs thousands of tokens and a turn.

#### KV Cache effect

Append-only; the notice is part of the new tool result and does not change earlier content.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The checker runs on the host of the subprocess runtime** — an on-disk checker reads the file at the path the filesystem backend reported, so it needs the backend and the subprocess runtime to share a filesystem. A stdin checker needs only the text.
- **Diagnostics are matched by message** — a change that adds a second copy of an existing diagnostic is reported. A change that fixes one diagnostic and introduces an identical one elsewhere is not.
- **Each edit adds up to the deadline** — a slow checker delays every checked result by up to `timeoutMs`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: incremental type checks

A long-lived checker process (a TypeScript language service or `tsc --watch`) could answer per-file type questions within the budget. It needs lifecycle management that a one-shot command does not.

</details>
