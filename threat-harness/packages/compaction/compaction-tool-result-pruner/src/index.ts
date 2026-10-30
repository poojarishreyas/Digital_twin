/**
 * Replay-safe, model-free tool-result pruning service: oversized results keep a head and tail,
 * and results a later call superseded collapse to a one-line marker naming the stored original.
 *
 * @module @elemental/compaction-tool-result-pruner
 */

import { Context, Service } from '@elemental/cordis'
import z from '@elemental/schemastery'
import { freezeMessage } from '@elemental/llm'
import { assertNever } from '@elemental/util-values'
import type { ContentBlock, ToolCallId } from '@elemental/llm'
import type { Session, SessionEvent, ToolResultMessage } from '@elemental/session'
// Type-only: the trigger union plus the `compaction/*` SessionEventMap merges (the shadow-price event).
import type { CompactionTrigger } from '@elemental/compaction'
// Type-only: the optional `ctx.spillStore` Context merge.
import type { SpillRef } from '@elemental/spill'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@elemental/token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig, spillMarker, supersededMarker } from './config.ts'
import type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  SupersessionRule,
  ToolCallRecord,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig, spillMarker, supersededMarker } from './config.ts'
export { rerunOf, sameArguments } from './supersession.ts'
export type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  SupersessionRule,
  ToolCallRecord,
  ToolResultPruneConfig,
} from './types.ts'

declare module '@elemental/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
  /** The call as supersession rules see it. */
  readonly record: ToolCallRecord
}

/** A candidate whose plain-marker replacement is known, before any spill or append. */
interface PlannedPrune extends SnapshotCandidate {
  readonly original: readonly ContentBlock[]
  readonly plain: ContentBlock[]
  readonly reason: PrunedEntry['reason']
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    protectRecentResults: z.number().step(1).min(0).default(DEFAULTS.protectRecentResults),
    minTokensSaved: z.number().step(1).min(0).default(DEFAULTS.minTokensSaved),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  /** Supersession rules by the earlier call's tool name. */
  private readonly rules = new Map<string, Set<SupersessionRule>>()

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Let a tool declare when a later call makes one of its results redundant. A pruning pass then
   * replaces such a result with a superseded marker, whatever its size.
   * @param toolName - the tool whose earlier results the rule judges.
   * @param rule - returns true when `later` supersedes `earlier`.
   * @returns the disposer that removes the rule.
   */
  registerSupersession(toolName: string, rule: SupersessionRule): () => void {
    let rules = this.rules.get(toolName)
    if (rules === undefined) {
      rules = new Set()
      this.rules.set(toolName, rules)
    }
    rules.add(rule)
    return () => {
      rules.delete(rule)
      if (rules.size === 0) this.rules.delete(toolName)
    }
  }

  /** Whether any later result supersedes `earlier` under its tool's rules. */
  private superseded(earlier: ToolCallRecord, later: readonly SnapshotCandidate[]): boolean {
    const rules = this.rules.get(earlier.name)
    if (rules === undefined) return false
    return later.some(candidate => [...rules].some(rule => rule(earlier, candidate.record)))
  }

  /** Superseded-marker replacement of `blocks`, or `null` when it would not be smaller. */
  private supersede(blocks: readonly ContentBlock[], toolName: string, ref?: SpillRef): ContentBlock[] | null {
    const chars = this.measureContent(blocks)
    const marker = supersededMarker(toolName, chars, ref)
    if (codePointLength(marker) >= chars) return null
    return [...blocks.filter(block => block.type !== 'text'), { type: 'text', text: marker }]
  }

  /** Whether `marker` joined to the configured head and tail stays within `thresholdChars`. */
  private markerFits(marker: string): boolean {
    return this.config.headChars + codePointLength(marker) + this.config.tailChars
      <= this.config.thresholdChars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @param marker - text substituted for the removed span; head + marker + tail must fit `thresholdChars`.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[], marker: string = PRUNE_MARKER): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const inserted = intersectsRemoved && !markerInserted ? marker : ''
      if (inserted.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + inserted
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune over-budget tool results, and replace superseded ones, from one current-surface snapshot.
   *
   * A result is superseded when a rule registered for its tool reports that a later result on the
   * surface makes it redundant; it is replaced by a one-line marker whatever its size, and
   * whatever its recency, because a newer equivalent stays in context. Otherwise an over-budget
   * result keeps its head and tail.
   *
   * A `pressure` pass never trims the newest `protectRecentResults` tool
   * results and lands nothing unless the plain-marker replacements would remove
   * at least `minTokensSaved` estimated tokens. A `cache-cold` pass keeps the
   * recency protection but needs no minimum gain, because the provider cache it
   * would invalidate has already expired. A `context-overflow` pass skips
   * both safeguards, because the unpruned request cannot be sent at all.
   *
   * When `ctx.spillStore` is mounted, each selected original's text is saved
   * first and its marker names the stored copy; a failed save, or a marker too
   * long for the budget, falls back to {@link PRUNE_MARKER}. Saves finish before
   * any append, and a result that left the surface meanwhile is skipped.
   *
   * Each replacement preserves the complete event data except for `content`,
   * cites the shadowed node so replay can recover the replacement input, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @param trigger - the compaction trigger that qualified this pass.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  async pruneSession(session: Session, trigger: CompactionTrigger): Promise<PruneResult> {
    const calls = callsById(session)
    const results: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type !== 'tool/result') continue
      const result = event.data.message.content[0]
      const call = calls.get(event.data.message.source.callId)
      results.push({
        seq,
        event,
        record: { name: call?.name ?? 'tool', args: parseArguments(call?.arguments), content: result.content, isError: result.isError === true },
      })
    }

    const { protectRecent, minGain } = safeguards(trigger)
    const trimmable = protectRecent ? Math.max(0, results.length - this.config.protectRecentResults) : results.length
    const planned: PlannedPrune[] = []
    let tokensSaved = 0
    results.forEach((candidate, index) => {
      const original = candidate.event.data.message.content[0].content
      const superseded = this.superseded(candidate.record, results.slice(index + 1))
        ? this.supersede(original, candidate.record.name)
        : null
      const plain = superseded ?? (index < trimmable ? this.pruneContent(original) : null)
      if (plain === null) return
      planned.push({ ...candidate, original, plain, reason: superseded === null ? 'oversized' : 'superseded' })
      tokensSaved += this.ctx.tokenMeter.estimateMessage(candidate.event.data.message)
        - this.ctx.tokenMeter.estimateMessage(withContent(candidate.event, plain))
    })
    if (minGain && tokensSaved < this.config.minTokensSaved) return { pruned: [], charsRemoved: 0 }

    const refs = await this.saveOriginals(session, planned)
    const onSurface = new Set(session.surface.nodes)
    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event, record, original, plain, reason } of planned) {
      if (!onSurface.has(seq)) continue
      const ref = refs.get(seq)
      let stored: SpillRef | undefined
      let content = plain
      if (reason === 'superseded') {
        // A stored copy only lengthens the marker; it is named when the marker still saves space.
        const named = ref === undefined ? null : this.supersede(original, record.name, ref)
        if (named !== null) {
          stored = ref
          content = named
        }
      } else {
        const marker = ref === undefined ? undefined : spillMarker(ref)
        stored = marker !== undefined && this.markerFits(marker) ? ref : undefined
        content = (stored === undefined ? null : this.pruneContent(original, marker)) ?? plain
      }
      const charsBefore = this.measureContent(original)
      const charsAfter = this.measureContent(content)
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message: withContent(event, content),
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        reason,
        charsBefore,
        charsAfter,
        ...stored === undefined ? {} : { spillLocator: stored.locator },
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }

  /**
   * Save each planned original's text through the optional spill store.
   * Best-effort: a missing store or a rejected save leaves that entry without a
   * stored copy, so it is pruned with the plain marker.
   */
  private async saveOriginals(session: Session, planned: readonly PlannedPrune[]): Promise<Map<number, SpillRef>> {
    const refs = new Map<number, SpillRef>()
    const store = this.ctx.get('spillStore')
    if (store === undefined) return refs
    for (const { seq, event, record, original } of planned) {
      const callId = event.data.message.source.callId
      const toolName = record.name
      try {
        refs.set(seq, await store.saveText({
          owner: { sessionId: session.id },
          source: { toolName, callId, label: 'pruned-result' },
          suggestedName: `${toolName}.txt`,
          content: textOf(original),
        }))
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `tool-result pruner: saving ${toolName} result ${callId} failed: ${String(error)}; pruning without a stored copy`,
        )
      }
    }
    return refs
  }
}

/** Which safeguards a trigger applies: recency protection for trimming, and the minimum gain. */
function safeguards(trigger: CompactionTrigger): { protectRecent: boolean; minGain: boolean } {
  switch (trigger) {
    case 'pressure':
      return { protectRecent: true, minGain: true }
    case 'cache-cold':
      return { protectRecent: true, minGain: false }
    case 'context-overflow':
      return { protectRecent: false, minGain: false }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(trigger, 'compaction trigger')
  }
}

/** Every logged tool call by id; a result whose call is absent from the log is attributed to `tool`. */
function callsById(session: Session): Map<ToolCallId, { name: string; arguments: string }> {
  const calls = new Map<ToolCallId, { name: string; arguments: string }>()
  for (const event of session.events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
  }
  return calls
}

/** Parse a call's raw JSON arguments; anything unparsable or absent is `undefined`. */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // The model produced malformed JSON; the call then has no arguments a rule can compare.
    return undefined
  }
}

/** The tool-result message of `event` with its single result's content replaced. */
function withContent(event: SessionEvent<'tool/result'>, content: ContentBlock[]): ToolResultMessage {
  const result = event.data.message.content[0]
  return freezeMessage<ToolResultMessage>({
    ...event.data.message,
    content: [{ ...result, content }] as [typeof result],
  })
}

/** Concatenated text of every text block; other blocks stay in the replacement itself. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

export default ToolResultPruner
