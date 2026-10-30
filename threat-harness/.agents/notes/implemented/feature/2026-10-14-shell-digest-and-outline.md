# Agent Note: Shell output spills at 8 KB with its failures listed, and read can outline a file

Status: implemented

## Problem

Two kinds of tool output cost the model turns or tokens it did not need to spend.

**Shell output.** A build or test log stayed inline up to the 50 KB spill cap, about 12,500 tokens, even though most of it was progress lines. Above the cap, the 2 KB preview kept only the head and tail, so a failure in the middle of a long log was cut. The model had to grep the spill file in another turn to find it.

**Reconnaissance.** Before editing, the model often reads several files only to learn what they declare. A `symbol` read needs a name the model may not know yet. A whole-file read costs the full file. The design sketch for this harness proposed giving `run_code` programs harness primitives (`grep`, `glob`, `read`, `outline`, `readSpill`), so recon could happen in one turn. It also proposed a read-only explore subagent.

## Decision

**Per-tool spill policies with a diagnostic preview.** `spill-policy` gains three settings:

- `toolPolicies`: per-tool `maxInlineBytes`, `previewBytes`, and `diagnosticBytes`. Omitted fields inherit the top-level values, shrunk to fit the tool's own limits.
- `diagnosticBytes`: the part of the preview reserved for omitted lines that match the diagnostic pattern. Defaults to `0`.
- `diagnosticPattern`: the pattern a diagnostic line matches. It defaults to the design's `(error|ERR!|FAIL|Exception|panic:|at .*\.[tj]sx?:\d+)`, case-insensitive, and is compiled at load.

With a diagnostic budget, the preview has four parts:

- The head, cut at its last line break.
- `[Matching lines from the omitted middle; numbers are lines in the stored file:]`.
- One `L<n>: <line>` entry per matching line, in order, until the next one does not fit. A line too long to fit whole keeps 40 characters before its match and is marked `…` on each cut side.
- The tail, starting after its first line break.

When nothing in the middle matches, the head and tail share the whole preview, as before. Both arms (the model-facing result and the `run_code` dispatch-log copy) use the tool's limits. `base` sets `bash`, `pwsh`, and `job_output` to `maxInlineBytes: 8192`, `previewBytes: 2560`, and `diagnosticBytes: 512`. Every other tool keeps 50,000 and 2,000.

**Outline reads.** `read` gains `outline: true`. It folds every function body and long comment in the file and puts nothing in focus. Its footer says how to read a declaration or region next. Its structured value lists `declarations`, each with a dotted `name`, `start`, and `end`, so a `run_code` program can pick a symbol or range without parsing the text. An outline has no plain fallback. An unsupported language, a streamed file, or an outline above `readMaxBytes` fails with a message that names what to read instead.

**Run_code primitives already existed.** In `ptc` and `both` tool modes, a `run_code` program calls `tools.grep`, `tools.glob`, and `tools.read` and gets structured values. `tools.read` on a spill locator is the `readSpill` primitive. `tools.read({ outline: true })` is the `outline` primitive. No `elemental.*` namespace was added.

## Alternatives considered

**Lower the global cap to 8 KB, as the design sketch proposed.** Rejected because the cap would apply to every tool. `web_fetch` pages and `grep` results are read for their content and have no diagnostic lines to rescue. Spilling them at 8 KB would trade one inline read for a preview plus a file read. Shell logs are the output that is mostly noise, so only the shell tools spill early.

**Fixed 1 KB head and 1 KB tail, as the design sketch proposed.** Not chosen as fixed sizes. The notice that names the spill file comes out of the same 2,560 bytes, so the head and tail get what is left after the notice and the diagnostic reservation, about 900 bytes each with the local spill root. Keeping `previewBytes` a hard cap on the whole replacement mattered more than exact end sizes.

**Wider default pattern (vitest `❯ file:line` frames, `warning:`).** Not adopted. Each addition also lists more noise, such as passing test names that contain "error", and the design specified this pattern. A deployment can set `diagnosticPattern`.

**Make `ptc` or `both` the default tool mode so recon happens in one turn.** Deferred. It changes every session's tool surface and system prompt and needs its own evaluation. The web bundle's `ELEMENTAL_TOOLS_MODE` switch and the `ptc` agent preset already opt in.

**A read-only explore subagent.** Deferred. In `both` mode, a `run_code` program already batches grep, glob, read, and outline calls in one turn without a second agent's context and cost.

**Return a declaration list instead of the folded text for outline reads.** Rejected for the model-facing text, because signatures show parameter and return types that names alone do not. The list is in the structured value, which only a program sees.

## Consequences

- A 40 KB test log costs about 640 tokens in context instead of about 10,000. Lines matching the pattern from the middle stay visible with the line numbers to read around them.
- Shell output between 8 KB and 50 KB now goes to a spill file. Recorded sessions that use `base` and produce such output need a snapshot refresh. Compositions that patch the `spill-policy` row replace its config, `toolPolicies` included.
- An outline costs about what a `symbol` read costs minus the declaration. Measured on this repository, that is 20% of the whole file for a 3,100-line analyzer and 23% for a 3,600-line client fixture module, but 42% for a 1,900-line module heavy with types and doc comments. A generated catalog has nothing to fold, so its outline costs the whole file.
- The `read` schema, tool description, and system-prompt guidance change. Recorded sessions that pin them need a snapshot refresh.

## Related

- [Spilled tool results keep a 2 KB preview](2026-09-29-spill-preview-size.md): the top-level preview size these tool policies refine.
- [PTC dispatch-log spill](2026-07-26-ptc-dispatch-log-spill.md): the second arm, which now uses the sub-call tool's limits.
- [Folded reads keep a file's outline around the requested code](2026-10-14-folded-reads.md): the fold planner an outline reuses with an empty focus.
