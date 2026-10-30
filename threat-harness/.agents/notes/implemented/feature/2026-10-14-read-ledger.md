# Agent Note: A per-session read ledger answers repeat reads with pointers and deltas

Status: implemented

## Problem

Every `read` resent the full window, even when the model had the same lines in context from a read a few steps earlier. A file that changed after the read was worse. A formatter, a pre-commit hook, codegen, or the model's own `edit` could shift lines, and the model then had two choices: re-read the whole file, or edit against line numbers and text it no longer had. A guarded `edit` of a file that changed underneath it failed with a bare "re-read the file, then retry", which cost another full read before the retry. Claude Code answers an identical repeat read with `file_unchanged` and tells the model not to re-read after editing. That rule breaks as soon as anything other than the model rewrites the file.

## Decision

`fs-observation-policy` keeps, beside each owner's observation, a `FsReadKnowledge` per file. It holds the file text as of the last read or delta, the 1-based line spans the reader was shown in full, and the evidence results that showed them (call id plus the text that result carried). `fs` declares the vocabulary and two events:

- `fs/read-recorded`: a synchronous recorder that replaces the knowledge.
- `fs/read-recall`: a single-slot lookup whose bare default is no knowledge.

A confirmed-absent observation discards knowledge.

`tool-fs` owns every decision; the policy only stores knowledge. For a model-direct read of an in-memory file, `read` first computes its normal result, then recalls:

- **Evidence check.** Knowledge counts only if every evidence result is on the session surface and still contains its recorded text. A result the pruner trimmed, the spill policy replaced, or a compaction summary absorbed fails this check, and so does a result not yet delivered (a parallel call in the same step).
- **Unchanged.** Identical text, and every line the read would show was already seen: the result is a one-line `file_unchanged` pointer.
- **Delta.** The text changed, and every unchanged line the read would show was already seen: the result is a `file_delta`. It holds the changed regions with two lines of context, numbered by current lines. It is used only when it needs at most as many changed lines as the read shows and its text is shorter than the full read. The delta becomes evidence, so the next read can be a pointer.
- **Full read.** In every other case the read is full. It records merged knowledge (same text) or fresh knowledge (new text).

When `edit` gets `FS_STALE_VERSION` and the knowledge holds, `edit` loads the file between two stats with the same version. It reports the changes in the delta form inside the failure, records the new knowledge with the failure as evidence, and emits a present observation at the current version, so the identical retry passes the guard. A change beyond `readLimit` lines or `readMaxBytes`, a streamed file, a second change during recovery, or any failure while building the report falls back to the generic remedy.

Line deltas use a bounded Myers diff in `line-diff.ts` that trims the common head and tail. It snapshots only the diagonals the backtrack reads, so memory grows with the edit distance squared, not the file length.

## Alternatives considered

**Turn ids in the pointer (`identical to Turn #4`), as the design sketch proposed.** Rejected because the model never sees turn numbers, so the id would be noise. Whether the earlier result is still in context is checked directly on the session surface, which is more precise than a turn id. A turn id would not catch a pruned or spilled result in a turn that is otherwise intact.

**Trust knowledge until compaction runs.** Rejected because the tool-result pruner and the spill policy change single results without a compaction event. Comparing the evidence text against the surface catches every way the model can lose the content, including hooks that rewrite results.

**Compute decisions in the policy plugin.** Rejected because the policy would need the session surface vocabulary, a diff, and the read tool's line model. The policy stays a store with no session or tool dependency, and the tool, which already owns line numbering and rendering, decides.

**Use the `diff` package already in `tool-fs`.** Rejected because the delta needs an edit budget and the old-to-new line mapping that carries seen lines forward, and its array diff has no cheap way to provide either. A dedicated 100-line Myers implementation is fuzz-tested against a dynamic-programming edit distance.

**Update knowledge after the model's own successful `edit`.** Rejected because the model's knowledge of an edit lives in its tool-call arguments, not in a result the evidence check can see. The next read returns the edit as a small delta instead.

## Consequences

- A repeat read of unchanged lines costs about 40 tokens instead of the full window, which is about 24,600 tokens for a 1,900-line file. After a formatter inserts an import and rewraps one statement, a full re-read of a 330–1,900-line file costs about 130–170 tokens.
- A stale edit no longer costs a re-read. The retry succeeds with the changes shown in the failure, which is the case Claude Code's "do not re-read after editing" rule gets wrong.
- Each session keeps the latest text of every file it read in memory until the session is collected. There is no cap, and knowledge is not persisted, so a resumed session reads in full again.
- The `read` result schema gains `unchanged` and `delta`. Reads and stale edits that hit the ledger produce model-visible text that recorded sessions must refresh. Every pointer and delta is an ordinary logged tool result, so model-visible input stays reconstructable from the session log.
- Tests that pass a hand-built `{ header }` object as the agent session now need a real `Session`, because recall reads the surface.

## Related

- [Folded reads keep a file's outline around the requested code](2026-10-14-folded-reads.md) — the folded view whose visible lines count as seen.
- [Tool-result pruner keeps recent results, skips small gains, and stores originals](2026-09-29-pruner-recency-gain-and-stored-originals.md) — one of the producers the evidence check guards against.
