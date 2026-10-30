/**
 * The spill-policy PLUGIN: a `tools/post-execute` result transformer that keeps
 * oversized plain-text tool results out of the model's context. When a final
 * result's UTF-8 size exceeds `maxInlineBytes`, it saves the FULL text to a
 * session-scoped spill artifact (`ctx.spillStore`) and replaces the
 * model-facing result with a bounded head/tail preview plus the backend's
 * locator and retrieval guidance.
 *
 * Per-tool policies (`toolPolicies`) override the cap, the preview size, and
 * the diagnostic budget for one tool. A diagnostic budget adds, between the
 * head and the tail, the omitted lines that match `diagnosticPattern`, each
 * numbered by its line in the stored file (see `./digest.ts`).
 *
 * It registers NO service and owns NO storage or preview mechanics: preview is
 * `@elemental/output-retention` (`TextRetainer`), storage is `ctx.spillStore`.
 * The policy only decides WHEN to spill and composes the notice.
 *
 * A second arm applies the SAME cap to the durable log: the
 * `tools/ptc-dispatch-log` waterfall bounds the `tool/code-dispatch` event's
 * copy of an oversized `run_code` sub-call result (the program's value is
 * untouched; UIs and replay read the full text through the spill artifact).
 *
 * ## Deliberately narrow
 *
 * - Omitted `maxInlineBytes` ⇒ the plugin registers nothing (a true no-op).
 * - Plain-text results only: a result carrying any non-text block is left
 *   untouched (the policy knows only the final formatted text, not tool
 *   internals).
 * - Nested composite calls skip the MODEL-facing arm; their durable log copy
 *   is bounded by the dispatch-log arm instead.
 * - Accepted value replacements pass through for registry revalidation and
 *   rendering; this presentation policy cannot also replace content in the
 *   same mutually exclusive decision.
 * - `read` is skipped by the model-facing arm to avoid a
 *   `read → spill → read again` loop; the dispatch-log arm bounds `read`
 *   sub-calls too (a log copy is not model context, and `read` is precisely
 *   the tool that produces huge logs).
 * - Best-effort: no session owner, no `ctx.spillStore` backend, or a save
 *   failure ⇒ log and return the original result. A spill failure must NEVER
 *   turn a successful tool call into an `isError` or hide the inline result.
 *
 * It COMPOSES with other post-execute listeners: its prepended listener
 * delegates via `next()` and bounds the resulting content projection, so
 * tool-owned asynchronous projection runs before generic bounding, a hook that
 * replaced content still has its replacement bounded, and value replacements
 * and `block` decisions pass through unchanged.
 *
 * @module @elemental/spill-policy
 */

import type { Context } from '@elemental/cordis'
import z from '@elemental/schemastery'
import type { ContentBlock } from '@elemental/llm'
import { describeOmitted } from '@elemental/output-retention'
import type { Omitted } from '@elemental/output-retention'
import type { SaveTextSpill, SpillRef } from '@elemental/spill'
import type { SessionId } from '@elemental/session'
import type { ToolCallId } from '@elemental/llm'
import type { PostToolDecision, ToolExecution } from '@elemental/tools'
import type { SpillPolicyExec } from './types.ts'
import { buildPreview } from './digest.ts'
import type { DiagnosticSpec } from './digest.ts'

export type { SpillPolicyExec } from './types.ts'
export { buildPreview, headTailPreview } from './digest.ts'
export type { DiagnosticSpec, Preview } from './digest.ts'

/**
 * The default `diagnosticPattern`: compiler and test-runner errors, npm errors, exceptions,
 * Go panics, and JavaScript/TypeScript stack frames. Matched case-insensitively.
 */
export const DEFAULT_DIAGNOSTIC_PATTERN = String.raw`(error|ERR!|FAIL|Exception|panic:|at .*\.[tj]sx?:\d+)`

/** Plugin config. */
export interface Config {
  /**
   * The model-facing context cap for a plain-text tool result, in UTF-8 bytes.
   * Omitted disables the policy entirely (no-op). When set, a result larger than
   * this is spilled and replaced with a preview derived from this same budget.
   */
  maxInlineBytes?: number
  /**
   * Model-facing size of a spilled result's replacement — head/tail preview plus
   * the storage notice — in UTF-8 bytes. Must not exceed `maxInlineBytes`.
   * Omitted spends the whole `maxInlineBytes` on the replacement.
   */
  previewBytes?: number
  /**
   * UTF-8 bytes of the preview reserved for lines from the omitted middle that
   * match `diagnosticPattern`, listed between the head and the tail with their
   * line numbers in the stored file. `0` (the default) keeps a plain head/tail
   * preview. When nothing matches, the head and tail use the whole preview.
   */
  diagnosticBytes?: number
  /**
   * Case-insensitive regular expression (source text) a diagnostic line
   * matches. Defaults to {@link DEFAULT_DIAGNOSTIC_PATTERN}.
   */
  diagnosticPattern?: string
  /** Per-tool overrides keyed by tool name, e.g. a lower cap and a diagnostic budget for `bash`. */
  toolPolicies?: Record<string, ToolSpillPolicy>
}

/**
 * One tool's override of the top-level limits. An omitted field inherits the top-level value,
 * shrunk to fit this tool's own limits: an inherited `previewBytes` to this `maxInlineBytes`, and
 * an inherited `diagnosticBytes` to this `previewBytes`.
 */
export interface ToolSpillPolicy {
  /** The cap for this tool's results, in UTF-8 bytes. */
  maxInlineBytes?: number
  /** The replacement size for this tool's spilled results, in UTF-8 bytes. At most this tool's `maxInlineBytes`. */
  previewBytes?: number
  /** Bytes of this tool's preview reserved for matching middle lines. At most this tool's `previewBytes`. */
  diagnosticBytes?: number
}

/** The limits that apply to one tool's results after inheritance. */
interface ResolvedLimits {
  maxInlineBytes: number
  previewBytes: number
  diagnostic: DiagnosticSpec | undefined
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spill-policy'

/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export const inject = ['tools']

export const Config: z<Config> = z.object({
  maxInlineBytes: z.number(),
  previewBytes: z.number(),
  diagnosticBytes: z.number(),
  diagnosticPattern: z.string(),
  toolPolicies: z.dict(z.object({
    maxInlineBytes: z.number(),
    previewBytes: z.number(),
    diagnosticBytes: z.number(),
  })),
})

/** All-text content flattened to one UTF-8 string, or `undefined` if any block is non-text. */
function flattenPlainText(content: ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

/** The owning session id, or `undefined` for a call with no agent (a direct/test call). */
function ownerSessionId(exec: ToolExecution): SessionId | undefined {
  return (exec as SpillPolicyExec).agent?.session.header.id
}

/** Whether `value` is a usable byte budget. */
function isBudget(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/**
 * Resolve and validate the limits for one scope (the top level, or a tool's override over it).
 * @param scope - the label used in error messages, e.g. `toolPolicies.bash`.
 * @throws when a field is negative or fractional, or a smaller limit exceeds the one containing it.
 */
function resolveLimits(scope: string, max: number, preview: number, diagnosticBytes: number, pattern: RegExp): ResolvedLimits {
  if (!isBudget(max)) throw new Error(`spill-policy: ${scope}maxInlineBytes must be a non-negative integer (got ${max})`)
  if (!isBudget(preview) || preview > max) {
    throw new Error(
      `spill-policy: ${scope}previewBytes must be a non-negative integer no larger than maxInlineBytes (got ${preview})`,
    )
  }
  if (!isBudget(diagnosticBytes) || diagnosticBytes > preview) {
    throw new Error(
      `spill-policy: ${scope}diagnosticBytes must be a non-negative integer no larger than previewBytes (got ${diagnosticBytes})`,
    )
  }
  return {
    maxInlineBytes: max,
    previewBytes: preview,
    diagnostic: diagnosticBytes === 0 ? undefined : { bytes: diagnosticBytes, pattern },
  }
}

/** The spill-notice line for a given omission + saved reference (no preview, no leading blank line). */
function spillNotice(omitted: Omitted, ref: SpillRef): string {
  const omission = describeOmitted(omitted, 'bytes')
  return `(${omission} Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint})`
}

export function apply(ctx: Context, config: Config): void {
  const maxInlineBytes = config.maxInlineBytes
  // Omitted ⇒ no automatic spill policy: register nothing at all. Tool
  // overrides refine a configured policy; alone they would be silently ignored.
  if (maxInlineBytes === undefined) {
    if (Object.keys(config.toolPolicies ?? {}).length > 0) {
      throw new Error('spill-policy: toolPolicies needs a top-level maxInlineBytes')
    }
    return
  }
  // Validate at LOAD, not per call: a negative/fractional cap would reach
  // TextRetainer's assertBudget and throw, turning every oversized-result call
  // into an isError. A bad config must fail the deployment, not the tool.
  let pattern: RegExp
  try {
    pattern = new RegExp(config.diagnosticPattern ?? DEFAULT_DIAGNOSTIC_PATTERN, 'i')
  } catch (error: unknown) {
    throw new Error(`spill-policy: diagnosticPattern is not a valid regular expression: ${String(error)}`)
  }
  const previewBytes = config.previewBytes ?? maxInlineBytes
  const diagnosticBytes = config.diagnosticBytes ?? 0
  const defaults = resolveLimits('', maxInlineBytes, previewBytes, diagnosticBytes, pattern)
  const perTool = new Map<string, ResolvedLimits>()
  for (const [toolName, policy] of Object.entries(config.toolPolicies ?? {})) {
    const max = policy.maxInlineBytes ?? maxInlineBytes
    // An inherited preview larger than this tool's lower cap shrinks to the cap.
    const preview = policy.previewBytes ?? Math.min(previewBytes, max)
    const diagnostic = policy.diagnosticBytes ?? Math.min(diagnosticBytes, preview)
    perTool.set(toolName, resolveLimits(`toolPolicies.${toolName}.`, max, preview, diagnostic, pattern))
  }
  const limitsFor = (toolName: string): ResolvedLimits => perTool.get(toolName) ?? defaults

  /**
   * Spill `text` and build the bounded replacement (preview + notice), or
   * return `undefined` when the policy must keep the original (no session
   * owner, no backend, storage failure, or no within-cap replacement).
   * Shared verbatim by the model-facing post-execute arm and the durable
   * dispatch-log arm so both produce byte-identical projections.
   */
  async function spillReplacement(
    text: string,
    totalBytes: number,
    sessionId: SessionId | undefined,
    toolName: string,
    callId: ToolCallId,
    label: 'result' | 'dispatch',
    limits: ResolvedLimits,
  ): Promise<string | undefined> {
    const cap = limits.previewBytes
    if (sessionId === undefined) {
      ctx.logger.warn(`spill-policy: no session owner for ${toolName} ${label}; keeping the inline content`)
      return undefined
    }
    const spillStore = ctx.get('spillStore')
    if (!spillStore) {
      ctx.logger.warn('spill-policy: no ctx.spillStore backend loaded; keeping the inline content')
      return undefined
    }
    const save: SaveTextSpill = {
      owner: { sessionId },
      source: { toolName, callId, label },
      suggestedName: `${toolName}.txt`,
      content: text,
    }
    let ref: SpillRef
    try {
      ref = await spillStore.saveText(save)
    } catch (error: unknown) {
      // Best-effort: a storage failure (permissions, ENOSPC, backend down) must
      // never fail the call or hide the content — keep the original inline.
      ctx.logger.warn(`spill-policy: saveText failed for ${toolName}: ${String(error)}; keeping the inline content`)
      return undefined
    }

    // Reserve the notice's byte cost INSIDE previewBytes so the replacement
    // (preview + blank line + notice) never exceeds the documented cap — a naive
    // preview that spent the whole budget then appended the notice could be
    // larger than the cap, and for a marginally-over result even larger than the
    // original. The reservation uses a notice priced at the worst-case omission
    // count (the full byte total): its digit count bounds the real count's, so
    // the reserved size is a safe upper bound and the final notice is never
    // longer than what we reserved. `\n\n` is the 2-byte join.
    const reserve = Buffer.byteLength(spillNotice({ kind: 'exact', count: totalBytes }, ref), 'utf8') + 2
    const previewBudget = Math.max(0, cap - reserve)
    // The diagnostic reservation never exceeds what the notice leaves for the preview.
    const diagnostic = limits.diagnostic === undefined
      ? undefined
      : { ...limits.diagnostic, bytes: Math.min(limits.diagnostic.bytes, previewBudget) }
    const { text: previewText, omitted } = buildPreview(text, previewBudget, diagnostic)
    const notice = spillNotice(omitted, ref)
    const replacedText = previewText.length > 0 ? `${previewText}\n\n${notice}` : notice
    // Invariant: the policy NEVER emits a replacement larger than previewBytes.
    // When the notice alone exceeds it (a tiny budget or a long spill root),
    // there is no within-cap replacement, so keep the inline content — spilling
    // would break the advertised cap. (previewBytes <= maxInlineBytes, and the
    // original is > maxInlineBytes by the entry condition, so a within-cap
    // replacement is always smaller than the original. The spill file already
    // written is a harmless orphan; cleanup is deferred.)
    if (Buffer.byteLength(replacedText, 'utf8') > cap) {
      ctx.logger.warn(`spill-policy: spill notice for ${toolName} exceeds previewBytes; keeping the inline content`)
      return undefined
    }
    return replacedText
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Delegate first so a downstream listener (e.g. a hook) settles the result;
    // we bound whatever it accepted. A block passes through — spill only shapes
    // accepted plain-text results, never corrective feedback.
    const decision = await next()
    // Skip `read` to avoid a read → spill → read again loop.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
      || exec.parent !== undefined || exec.name === 'read') return decision

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision
    const limits = limitsFor(exec.name)
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= limits.maxInlineBytes) return decision

    const replacedText = await spillReplacement(
      text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, 'result', limits)
    if (replacedText === undefined) return decision
    const replaced: ContentBlock[] = [{ type: 'text', text: replacedText }]
    return { kind: 'accept', content: replaced, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  }, { prepend: true })

  // The durable-log arm: bound the `tool/code-dispatch` event's copy of an
  // oversized sub-call result the same way the model-facing arm bounds an
  // outer result. The program's returned value is untouched (it already
  // crossed the worker boundary whole); only the session log's copy shrinks
  // to preview + locator, so replay and UIs read the full text through the
  // spill artifact exactly as they do for spilled native results.
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next): Promise<ContentBlock[]> => {
    const content = await next()
    // `read` sub-calls spill too: the log copy is not model context, so the
    // read → spill → read-again loop the post-execute arm avoids cannot
    // happen here, and read is precisely the tool that produces huge logs.
    const text = flattenPlainText(content)
    if (text === undefined) return content
    const limits = limitsFor(dispatch.name)
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= limits.maxInlineBytes) return content

    const replacedText = await spillReplacement(
      text, totalBytes, ownerSessionId(dispatch.exec), dispatch.name, dispatch.subCallId, 'dispatch', limits)
    if (replacedText === undefined) return content
    return [{ type: 'text', text: replacedText }]
  }, { prepend: true })
}
