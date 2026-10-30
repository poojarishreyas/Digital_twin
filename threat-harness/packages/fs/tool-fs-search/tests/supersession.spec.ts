/**
 * The `grep` and `glob` supersession rules' registration with the tool-result pruner: an earlier
 * search with identical arguments collapses once the same search succeeds again, and disposing
 * the tools removes the rules.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import { createToolResultMessage, ToolCallId } from '@elemental/llm'
import { Session, SessionId } from '@elemental/session'
import SessionProjectionRegistry from '@elemental/session-projection'
import SystemPrompt from '@elemental/system-prompt'
import TokenMeter from '@elemental/token-meter'
import ToolRuntime from '@elemental/tools'
import { SubprocessRuntime } from '@elemental/subprocess'
import ToolResultPruner from '@elemental/compaction-tool-result-pruner'
import * as ToolFsSearch from '@elemental/tool-fs-search'

/** Satisfies the `subprocess` injection; registration never spawns. */
// @ts-expect-error -- the abstract spawn members are never called here.
class NoSubprocess extends SubprocessRuntime {}

/** A session whose surface holds one result per call, in order. */
function searches(...calls: [string, object][]): { session: Session; seqs: number[] } {
  const session = Session.create(SessionId('searches'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const seqs = calls.map(([name, args], index) => {
    const callId = ToolCallId(`s${index}`)
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
    return session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `${name} ${index}\n${'src/a.ts (3)\n'.repeat(40)}` }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }).seq
  })
  return { session, seqs }
}

describe('search supersession', () => {
  it('collapses an identical earlier grep or glob while the tools are mounted, and stops after disposal', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    const pruner = new ToolResultPruner(ctx, { protectRecentResults: 0, minTokensSaved: 0 })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NoSubprocess)
    const fiber = await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })

    const mounted = searches(
      ['grep', { pattern: 'foo', include: '*.ts' }],
      ['glob', { pattern: '**/*.ts' }],
      ['grep', { include: '*.ts', pattern: 'foo' }],
      ['grep', { pattern: 'foo' }],
      ['glob', { pattern: '**/*.ts' }],
    )
    expect((await pruner.pruneSession(mounted.session, 'cache-cold')).pruned.map(entry => [entry.originalSeq, entry.reason]))
      .toEqual([[mounted.seqs[0], 'superseded'], [mounted.seqs[1], 'superseded']])

    await fiber.dispose()
    const unmounted = searches(['grep', { pattern: 'foo' }], ['grep', { pattern: 'foo' }])
    expect((await pruner.pruneSession(unmounted.session, 'cache-cold')).pruned).toEqual([])
  })
})
