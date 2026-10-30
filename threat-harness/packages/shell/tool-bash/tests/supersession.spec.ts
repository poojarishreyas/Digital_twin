/**
 * The `bash` supersession rule's registration with the tool-result pruner: an earlier run of the
 * same command in the same working directory collapses once a later run succeeds, and disposing
 * the tool removes the rule.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import { createToolResultMessage, ToolCallId } from '@elemental/llm'
import { Session, SessionId } from '@elemental/session'
import SessionProjectionRegistry from '@elemental/session-projection'
import SystemPrompt from '@elemental/system-prompt'
import TokenMeter from '@elemental/token-meter'
import ToolRuntime from '@elemental/tools'
import AgentRegistry from '@elemental/agent'
import ToolResultPruner from '@elemental/compaction-tool-result-pruner'
import { LocalBashExecutor } from '@elemental/bash-local'
import LocalSubprocessRuntime from '@elemental/subprocess-local'
import * as BashEnvPlugin from '@elemental/shell-env'
import * as ToolBash from '@elemental/tool-bash'

/** A session whose surface holds one `bash` result per argument set, in order. */
function runs(...calls: object[]): { session: Session; seqs: number[] } {
  const session = Session.create(SessionId('bash-runs'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const seqs = calls.map((args, index) => {
    const callId = ToolCallId(`b${index}`)
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify(args) })
    return session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `run ${index}\n${'output '.repeat(100)}` }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }).seq
  })
  return { session, seqs }
}

describe('bash supersession', () => {
  it('collapses an earlier run of the same command and workdir while the tool is mounted, and stops after disposal', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    const pruner = new ToolResultPruner(ctx, { protectRecentResults: 0, minTokensSaved: 0 })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    const fiber = await ctx.plugin(ToolBash)

    const mounted = runs({ command: 'pnpm test' }, { command: 'pnpm test', workdir: 'pkg' }, { command: 'pnpm test' })
    expect((await pruner.pruneSession(mounted.session, 'cache-cold')).pruned.map(entry => [entry.originalSeq, entry.reason]))
      .toEqual([[mounted.seqs[0], 'superseded']])

    await fiber.dispose()
    expect((await pruner.pruneSession(runs({ command: 'ls' }, { command: 'ls' }).session, 'cache-cold')).pruned).toEqual([])
  })
})
