import type { ContentBlock, ToolCallId } from '@elemental/llm'
import type { SpillLocator } from '@elemental/spill'

/** Budget and selection policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
  /**
   * Newest tool results a pressure pass never prunes, counted over every current
   * tool result regardless of size. Overflow recovery ignores it. Defaults to `5`.
   */
  protectRecentResults?: number
  /**
   * Minimum estimated tokens a pressure pass must remove, or it prunes nothing.
   * Overflow recovery ignores it. Defaults to `20000`.
   */
  minTokensSaved?: number
}

/** Validated, detached, deeply immutable pruning configuration. */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
  readonly protectRecentResults: number
  readonly minTokensSaved: number
}

/** One completed tool call as a {@link SupersessionRule} sees it. */
export interface ToolCallRecord {
  /** The tool's registered name. */
  readonly name: string
  /** Parsed call arguments; `undefined` when the logged arguments are not valid JSON. */
  readonly args: unknown
  /** The result's current content. */
  readonly content: readonly ContentBlock[]
  /** Whether the result is an error. */
  readonly isError: boolean
}

/**
 * Decide whether a later call makes an earlier call's result redundant, so the earlier result may
 * be replaced by a short superseded marker. Registered per tool name for the earlier call; the
 * later call may be of any tool.
 */
export type SupersessionRule = (earlier: ToolCallRecord, later: ToolCallRecord) => boolean

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: number
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: number
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Why the result was replaced: its text exceeded the budget, or a later call superseded it. */
  readonly reason: 'oversized' | 'superseded'
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
  /** Where the original text was saved, when a spill store accepted it and its marker fit the budget. */
  readonly spillLocator?: SpillLocator
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
