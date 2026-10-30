/**
 * Superseded results: tool-declared rules collapse an earlier result that a later call replaced
 * into a one-line marker during a pruning pass, and the cache-cold trigger's safeguards.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import { createMessage, createToolResultMessage, ToolCallId } from '@elemental/llm'
import type { ContentBlock } from '@elemental/llm'
import { Session, SessionId } from '@elemental/session'
import SessionProjectionRegistry from '@elemental/session-projection'
import { SpillLocator, SpillStore } from '@elemental/spill'
import type { SaveTextSpill, SpillRef } from '@elemental/spill'
import TokenMeter from '@elemental/token-meter'
import ToolResultPruner, { rerunOf, sameArguments, supersededMarker } from '@elemental/compaction-tool-result-pruner'
import type { ToolCallRecord, ToolResultPruneConfig } from '@elemental/compaction-tool-result-pruner'

/** Generous budgets with both pressure safeguards off, so supersession decides alone. */
const OPEN: ToolResultPruneConfig = { thresholdChars: 100_000, headChars: 10, tailChars: 10, protectRecentResults: 0, minTokensSaved: 0 }

class Store extends SpillStore {
  override saveText(input: SaveTextSpill): Promise<SpillRef> {
    return Promise.resolve({ locator: SpillLocator(`/spill/${input.source.callId}.txt`), bytes: input.content.length, retrievalHint: 'Use read.' })
  }
}

function pruner(config: ToolResultPruneConfig = OPEN, store = false): ToolResultPruner {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  if (store) void new Store(ctx)
  return new ToolResultPruner(ctx, config)
}

let turn = 0
/** A new session; call ids restart at `c1`. */
function fresh(id: string): Session {
  turn = 0
  return Session.create(SessionId(id))
}

/** Append one closed turn holding a single tool call and its result. */
function step(session: Session, name: string, args: string, content: ContentBlock[] | string, isError = false, logCall = true): number {
  turn += 1
  const callId = ToolCallId(`c${turn}`)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: args }], source: { kind: 'model', provider: 'p', model: 'm' } }),
  }, { surfaceOp: 'append' })
  if (logCall) session.append('tool/call', { turn, step: 1, callId, name, arguments: args })
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  const result = session.append('tool/result', {
    turn, step: 1, message: createToolResultMessage({ callId, content: blocks, isError }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

function text(session: Session, seq: number): string {
  const event = session.events[seq]
  if (event?.type !== 'tool/result') throw new Error('not a result')
  return event.data.message.content[0].content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('')
}

/** The text a seq currently shows on the surface, following replacements. */
function surfaced(session: Session, seq: number): string {
  const node = session.surface.nodes.find((candidate) => {
    const event = session.events[candidate]
    return event?.type === 'tool/result' && (candidate === seq || event.sourceEventSeqs?.includes(seq) === true)
  })
  if (node === undefined) throw new Error('not on surface')
  return text(session, node)
}

const LOG = 'FAIL '.repeat(100)

describe('supersession rules', () => {
  it('replaces an earlier result a rule says was superseded, keeping the latest whole', async () => {
    const prune = pruner()
    prune.registerSupersession('bash', rerunOf('command'))
    const session = fresh('rerun')
    const first = step(session, 'bash', '{"command":"pnpm test"}', LOG)
    const other = step(session, 'bash', '{"command":"ls"}', LOG)
    const last = step(session, 'bash', '{"command":"pnpm test","description":"again"}', 'ok')
    const result = await prune.pruneSession(session, 'pressure')
    expect(result.pruned.map(entry => [entry.originalSeq, entry.reason])).toEqual([[first, 'superseded']])
    expect(surfaced(session, first)).toBe(supersededMarker('bash', 500))
    expect(surfaced(session, first)).toBe('[Superseded: this bash result (500 chars) was replaced by a later call.]')
    expect(surfaced(session, other)).toBe(LOG)
    expect(surfaced(session, last)).toBe('ok')
  })

  it('names the stored original, keeps non-text blocks, and skips a result the marker would not shrink', async () => {
    const prune = pruner(OPEN, true)
    prune.registerSupersession('grep', rerunOf())
    const session = fresh('stored')
    const big = step(session, 'grep', '{"pattern":"x"}', [{ type: 'text', text: LOG }, { type: 'reasoning', text: 'kept' }])
    const small = step(session, 'grep', '{"pattern":"y"}', 'tiny')
    step(session, 'grep', '{"pattern":"x"}', 'new')
    step(session, 'grep', '{"pattern":"y"}', 'new')
    const result = await prune.pruneSession(session, 'context-overflow')
    expect(result.pruned).toEqual([expect.objectContaining({ originalSeq: big, reason: 'superseded', spillLocator: '/spill/c1.txt' })])
    expect(surfaced(session, big)).toBe('<reasoning>[Superseded: this grep result (500 chars) was replaced by a later call. Full result stored at: /spill/c1.txt. Use read.]')
    expect(surfaced(session, small)).toBe('tiny')
  })

  it('falls back to the bare marker when naming the stored copy would not shrink the result', async () => {
    const prune = pruner(OPEN, true)
    prune.registerSupersession('grep', rerunOf())
    const session = fresh('bare')
    const mid = 'm'.repeat(90)
    const seq = step(session, 'grep', '{"pattern":"x"}', mid)
    step(session, 'grep', '{"pattern":"x"}', 'new')
    const [entry] = (await prune.pruneSession(session, 'context-overflow')).pruned
    expect(entry).toMatchObject({ reason: 'superseded' })
    expect(entry?.spillLocator).toBeUndefined()
    expect(surfaced(session, seq)).toBe('[Superseded: this grep result (90 chars) was replaced by a later call.]')
  })

  it('supersedes regardless of recency protection, but still trims oversized results only outside it', async () => {
    const prune = pruner({ thresholdChars: 100, headChars: 10, tailChars: 10, protectRecentResults: 5, minTokensSaved: 0 })
    prune.registerSupersession('bash', rerunOf('command'))
    const session = fresh('recent')
    const first = step(session, 'bash', '{"command":"a"}', LOG)
    const unrelated = step(session, 'read', '{"file_path":"x"}', LOG)
    step(session, 'bash', '{"command":"a"}', 'done')
    const result = await prune.pruneSession(session, 'cache-cold')
    expect(result.pruned.map(entry => [entry.originalSeq, entry.reason])).toEqual([[first, 'superseded']])
    expect(surfaced(session, unrelated)).toBe(LOG)
  })

  it('applies no minimum gain on a cache-cold pass but keeps it under pressure', async () => {
    const config = { ...OPEN, minTokensSaved: 1_000_000 }
    for (const [trigger, count] of [['pressure', 0], ['cache-cold', 1]] as const) {
      const prune = pruner(config)
      prune.registerSupersession('bash', rerunOf('command'))
      const session = fresh(trigger)
      step(session, 'bash', '{"command":"a"}', LOG)
      step(session, 'bash', '{"command":"a"}', 'done')
      expect((await prune.pruneSession(session, trigger)).pruned).toHaveLength(count)
    }
  })

  it('ignores tools without rules, unparsable arguments, unlogged calls, and removed rules', async () => {
    const prune = pruner()
    const dispose = prune.registerSupersession('bash', rerunOf())
    const extra = prune.registerSupersession('bash', () => false)
    const session = fresh('ignored')
    const broken = step(session, 'bash', '{not json', LOG)
    step(session, 'bash', '{not json', 'again')
    const unlogged = step(session, 'bash', '{"command":"a"}', LOG, false, false)
    step(session, 'bash', '{"command":"a"}', 'again', false, false)
    const other = step(session, 'web', '{"q":1}', LOG)
    step(session, 'web', '{"q":1}', 'again')
    expect((await prune.pruneSession(session, 'context-overflow')).pruned).toEqual([])
    expect([surfaced(session, broken), surfaced(session, unlogged), surfaced(session, other)]).toEqual([LOG, LOG, LOG])
    dispose()
    extra()
    const later = fresh('disposed')
    step(later, 'bash', '{"command":"a"}', LOG)
    step(later, 'bash', '{"command":"a"}', 'again')
    expect((await prune.pruneSession(later, 'context-overflow')).pruned).toEqual([])
  })
})

describe('rerunOf and sameArguments', () => {
  const call = (name: string, args: unknown, isError = false): ToolCallRecord => ({ name, args, content: [], isError })

  it('compares whole arguments ignoring key order, or only the named keys with absence as a value', () => {
    expect(sameArguments({ a: 1, b: [1, { c: 'x', d: null }] }, { b: [1, { d: null, c: 'x' }], a: 1 })).toBe(true)
    expect(sameArguments({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameArguments(undefined, undefined)).toBe(false)
    const whole = rerunOf()
    expect(whole(call('grep', { p: 1 }), call('grep', { p: 1 }))).toBe(true)
    expect(whole(call('grep', { p: 1 }), call('grep', { p: 1 }, true))).toBe(false)
    expect(whole(call('grep', { p: 1 }), call('glob', { p: 1 }))).toBe(false)
    const keyed = rerunOf('command', 'workdir')
    expect(keyed(call('bash', { command: 'x', description: 'a' }), call('bash', { command: 'x' }))).toBe(true)
    expect(keyed(call('bash', { command: 'x' }), call('bash', { command: 'x', workdir: 'sub' }))).toBe(false)
    expect(keyed(call('bash', 'x'), call('bash', 'x'))).toBe(true)
    expect(keyed(call('bash', undefined), call('bash', { command: 'x' }))).toBe(false)
    expect(keyed(call('bash', { command: 'x' }), call('bash', undefined))).toBe(false)
  })
})
