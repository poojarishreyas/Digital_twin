# Agent Note: Folds rewrite history only when the prompt cache is already lost

Status: implemented

## Problem

Provider prompt caching bills a request prefix that matches the previous request at a fraction of the normal input price, and returns the first token sooner. Any rewrite of earlier history breaks the match from the rewritten point onward. The design sketch for this harness framed three needs:

- Keep turns within a task append-only, so each step hits the cache.
- Fold only at boundaries, down to a low-water mark.
- Replace dead tool output with short tombstones that still say where the full text lives.

The harness already met the first two at pressure. `compaction-basic` summarizes only above `thresholdRatio` and keeps `retainRatio` verbatim. Under pressure, `compaction-tool-result-pruner` leaves the newest `protectRecentResults` results alone and rewrites nothing unless the pass saves at least `minTokensSaved` tokens. Three gaps remained:

- **A missed free fold.** After a long idle gap the provider cache has expired, so the next request pays full price anyway. The harness still waited for pressure before trimming, so that free chance to fold was lost.
- **Outdated output stayed whole.** A test suite run five times, or a search or read repeated after a change, kept every copy in full until pressure trimmed them by size. The size trim keeps the head and tail of each copy.
- **No search after a fold.** Once compaction removed text, the model had no way to search it unless a deployment had turned search on from startup.

## Decision

**Cache-cold fold.** `CompactionTrigger` gains `'cache-cold'`. The `coldCacheAfterMs` policy field can be set at the top level or per model, and defaults to `0` (off). When it is set and more than that time has passed since the session's latest `assistant/message`, `compaction-basic` runs the mounted pruner with `cache-cold` before the step's pressure check. That pass keeps the recency window but drops the minimum gain, makes no model call, and runs no summary. The pressure check then measures the smaller request.

**Superseded markers.** The pruner gains `registerSupersession(toolName, rule)`. A rule decides whether a later call's result makes an earlier result of its tool redundant. During any pass, a matched result is replaced by `[Superseded: this <tool> result (<n> chars) was replaced by a later call.]`. When a spill store saved the original, the marker also names it. The replacement happens whatever the result's size and even inside the recency window, because its newer equivalent stays in context. Superseded markers count toward `minTokensSaved`, so a pressure pass still rewrites only when the total gain is worth a cache break. The helpers `rerunOf(...keys)` and `sameArguments` cover the common rules. Shipped tools register these:

- `bash`: same `command` and `workdir`.
- `grep` and `glob`: identical arguments.
- `read`: an identical read that returned file content, or a successful `write` of the same path.

**Read ledger.** The `read` ledger from the read-ledger note needed no new invalidation. Its evidence check already fails once a result is pruned, superseded, or summarized. One change keeps it useful under supersession: a full re-read that showed every known line becomes the ledger's only evidence, so superseding the older read leaves the knowledge valid.

**Search after compaction.** `session-query-sqlite` gains `openAt: 'after-compaction'`. Search stays closed, as under `never`, until the process sees the first surface replacement (a pruned result or a summary), and then opens at the next search. Replaced originals remain searchable as `shadowed` events. The shipped bundles keep `openAt: never`. They do not mount the model-facing session tools, so opening the index there would only change the Web sidebar's content search partway through a session.

## Alternatives considered

**Trigger on an uncached-tail high-water mark, as the design sketch proposed.** Rejected because tail tokens since the last fold are uncached once at most and then cached. Folding when the tail grows would break the cache to save tokens that were about to become cheap. The pressure trigger with a minimum gain already folds only when the context itself is large.

**Model-written semantic tombstones (`failed with 2 TypeErrors in auth.ts -> Fixed in Turn #15`).** Rejected because each tombstone would need a model call at fold time, and its claims about later turns could be wrong, with nothing in the log to check them against. Superseded markers are deterministic, cost no call, and name the stored original. The summary already carries the narrative when a summary runs.

**Phase-transition folds (after an investigation, or when tests pass).** Deferred. No current signal marks a phase reliably, and a wrong guess would break the cache mid-task.

**Ship `openAt: after-compaction` by default.** Rejected for the reasons in the decision: without the model-facing tools, only the Web sidebar would notice, and it would change behavior partway through a session. [Session search not shipped by default](2026-08-02-session-search-not-shipped-default.md) records why search is opt-in.

**Supersede by content similarity.** Rejected because two outputs of the same command can differ in exactly the line the model needs. Tool-declared rules over arguments state when a later result really replaces an earlier one.

## Consequences

- On a route whose cache lifetime is configured, the first step after an idle gap pays for its fold, at no model cost. Every later step reuses the new prefix until the next pressure fold.
- A re-run test suite, repeated search, or repeated full read keeps only its latest copy in full after the next fold. Each earlier copy shrinks to roughly 25–60 tokens.
- `coldCacheAfterMs` defaults to off because cache lifetimes vary by provider and are not published as fixed values for every route. A deployment sets it per model.
- Tools that register rules (`tool-bash`, `tool-fs-search`, `tool-fs`) peer-depend on the pruner for its helpers. The rules are registered only when `ctx.toolResultPruner` is mounted.
- The `after-compaction` trigger is process-wide and in memory: after a restart, search reopens at the next compaction.

## Related

- [Tool-result pruner keeps recent results, skips small gains, and stores originals](2026-09-29-pruner-recency-gain-and-stored-originals.md) — the pressure safeguards this note builds on.
- [A per-session read ledger answers repeat reads with pointers and deltas](2026-10-14-read-ledger.md) — the evidence check that turns any fold into read invalidation.
