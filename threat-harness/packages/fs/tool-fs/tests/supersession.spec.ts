/**
 * The `read` supersession rule and its registration with the tool-result pruner: which later calls
 * replace an earlier read, and that disposing the tool suite removes the rule.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import { createMessage, createToolResultMessage, ToolCallId } from '@elemental/llm'
import { Session, SessionId } from '@elemental/session'
import SessionProjectionRegistry from '@elemental/session-projection'
import SystemPrompt from '@elemental/system-prompt'
import TokenMeter from '@elemental/token-meter'
import ToolRuntime from '@elemental/tools'
import ToolResultPruner from '@elemental/compaction-tool-result-pruner'
import type { ToolCallRecord } from '@elemental/compaction-tool-result-pruner'
import { FileSystem } from '@elemental/fs'
import * as ToolFs from '@elemental/tool-fs'
import { readSuperseded } from '../src/supersession.ts'

const full = '<path>/abs/a.ts</path>\n<type>file</type>\n<content>\n1: x\n</content>'
const call = (name: string, args: unknown, text: string, isError = false): ToolCallRecord => ({ name, args, content: [{ type: 'text', text }], isError })

describe('readSuperseded', () => {
  const earlier = call('read', { file_path: 'a.ts', offset: 1 }, full)

  it('is superseded by an identical full re-read or a write of the same path', () => {
    expect(readSuperseded(earlier, call('read', { offset: 1, file_path: 'a.ts' }, full))).toBe(true)
    expect(readSuperseded(earlier, call('write', { file_path: 'a.ts', content: 'y' }, 'Updated file'))).toBe(true)
  })

  it('is not superseded by a pointer, a delta, another window, another path, or a failed call', () => {
    expect(readSuperseded(earlier, call('read', { file_path: 'a.ts', offset: 1 }, '[file_unchanged: /abs/a.ts L1-L1 …]'))).toBe(false)
    expect(readSuperseded(earlier, call('read', { file_path: 'a.ts', offset: 1 }, '[file_delta: …]'))).toBe(false)
    expect(readSuperseded(earlier, call('read', { file_path: 'a.ts', offset: 2 }, full))).toBe(false)
    expect(readSuperseded(earlier, call('write', { file_path: 'b.ts' }, 'Created file'))).toBe(false)
    expect(readSuperseded(earlier, call('write', { file_path: 'a.ts' }, 'Error: denied', true))).toBe(false)
    expect(readSuperseded(call('read', 'garbage', full), call('write', { file_path: 'a.ts' }, 'ok'))).toBe(false)
    expect(readSuperseded(call('read', { file_path: 3 }, full), call('write', { file_path: 3 }, 'ok'))).toBe(false)
    expect(readSuperseded(earlier, call('edit', { file_path: 'a.ts' }, 'ok'))).toBe(false)
  })
})

/** Satisfies tool-fs's `fs` dependency; the registration test never calls the filesystem. */
// @ts-expect-error -- the abstract filesystem members are never called here.
class NoFs extends FileSystem {}

describe('pruner registration', () => {
  /** A session where `a.ts` was read twice with the same arguments, each in its own closed turn. */
  function twoReads(): { session: Session; first: number } {
    const session = Session.create(SessionId('reads'))
    const seqs = [1, 2].map((turn) => {
      const callId = ToolCallId(`r${turn}`)
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        turn, step: 1,
        message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"file_path":"a.ts"}' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{"file_path":"a.ts"}' })
      const result = session.append('tool/result', {
        turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `${full}${' '.repeat(400)}` }], isError: false }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return result.seq
    })
    return { session, first: seqs[0]! }
  }

  it('registers the read rule while both plugins are mounted and removes it on disposal', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    const pruner = new ToolResultPruner(ctx, { protectRecentResults: 0, minTokensSaved: 0 })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NoFs)
    const fiber = await ctx.plugin(ToolFs)

    const mounted = twoReads()
    expect((await pruner.pruneSession(mounted.session, 'context-overflow')).pruned.map(entry => [entry.originalSeq, entry.reason]))
      .toEqual([[mounted.first, 'superseded']])

    await fiber.dispose()
    expect((await pruner.pruneSession(twoReads().session, 'context-overflow')).pruned).toEqual([])
  })
})
