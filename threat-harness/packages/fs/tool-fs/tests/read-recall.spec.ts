/**
 * Read recall decisions over recorded knowledge: when a reader holds the requested lines, when a
 * delta brings it current, which lines it knows afterwards, and when its evidence still counts.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@elemental/session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@elemental/llm'
import type { ContentBlock } from '@elemental/llm'
import type { FsReadKnowledge } from '@elemental/fs'
import { evidenceVisible, knowledgeAfterRead, recallRead, spansOf, textLines } from '../src/read-recall.ts'

const evidence = { callId: 'c1', text: 'shown' }
const lines = (count: number): string => `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')}\n`

describe('textLines and spansOf', () => {
  it('numbers lines as the read window does', () => {
    expect(textLines('')).toEqual([])
    expect(textLines('a\n')).toEqual(['a'])
    expect(textLines('a\r\nb\n\n')).toEqual(['a', 'b', ''])
    expect(textLines('a\nb')).toEqual(['a', 'b'])
  })

  it('collapses ascending numbers into maximal spans', () => {
    expect(spansOf([1, 2, 3, 5, 7, 8])).toEqual([{ start: 1, end: 3 }, { start: 5, end: 5 }, { start: 7, end: 8 }])
    expect(spansOf([])).toEqual([])
  })
})

describe('recallRead', () => {
  const known: FsReadKnowledge = { text: lines(10), seen: [{ start: 1, end: 6 }], evidence: [evidence] }

  it('points at the earlier read when the text is the same and every requested line was seen', () => {
    expect(recallRead(known, lines(10), [2, 3, 4], 10)).toEqual({ kind: 'unchanged', spans: [{ start: 2, end: 4 }] })
    expect(recallRead(known, lines(10), [5, 6, 7], 10)).toBeUndefined()
  })

  it('describes a change as hunks when every unchanged requested line was seen', () => {
    const changed = lines(10).replace('line 3\n', 'line 3\ninserted\n')
    const recalled = recallRead(known, changed, [1, 2, 3, 4, 5], 10)
    if (recalled?.kind !== 'delta') throw new Error('expected a delta')
    expect(recalled.previousTotalLines).toBe(10)
    expect(recalled.hunks.flat().filter(line => line.op === '+')).toEqual([{ op: '+', newNumber: 4, text: 'inserted' }])
    // Seen lines 1-6 shift past the insertion to 1-3 and 5-7; the hunk shows 2-6 in full.
    expect(recalled.next).toEqual({ seen: [{ start: 1, end: 7 }], previous: [evidence] })
  })

  it('needs a full read when an unchanged requested line was never seen or the change is too large', () => {
    const changed = lines(10).replace('line 1\n', 'first\n')
    expect(recallRead(known, changed, [9], 10)).toBeUndefined()
    expect(recallRead(known, 'other\n', [1], 1)).toBeUndefined()
  })
})

describe('knowledgeAfterRead', () => {
  const read = { callId: 'c2', text: 'second' }

  it('starts fresh without prior knowledge of the same text', () => {
    expect(knowledgeAfterRead(undefined, lines(3), [1, 2], read))
      .toEqual({ text: lines(3), seen: [{ start: 1, end: 2 }], evidence: [read] })
    const stale = { text: 'old\n', seen: [{ start: 1, end: 1 }], evidence: [evidence] }
    expect(knowledgeAfterRead(stale, lines(3), [3], read)).toEqual({ text: lines(3), seen: [{ start: 3, end: 3 }], evidence: [read] })
  })

  it('merges the shown lines into knowledge of the same text', () => {
    const prior = { text: lines(5), seen: [{ start: 1, end: 2 }], evidence: [evidence] }
    expect(knowledgeAfterRead(prior, lines(5), [4, 5], read)).toEqual({
      text: lines(5),
      seen: [{ start: 1, end: 2 }, { start: 4, end: 5 }],
      evidence: [evidence, read],
    })
  })
})

describe('evidenceVisible', () => {
  function sessionWith(results: [string, string][]): { session: Session; seqs: number[] } {
    const session = Session.create(SessionId('s1'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'shown' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    const seqs = results.map(([callId, text]) => {
      const call = session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name: 'read', arguments: '{}' })
      // A non-text block beside the text contributes nothing to the evidence text.
      const content: ContentBlock[] = [{ type: 'text', text }, { type: 'reasoning', text: 'not evidence' }]
      return session.append('tool/result', {
        turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(callId), content, isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] }).seq
    })
    return { session, seqs }
  }

  it('holds while every result is on the surface and still contains its text', () => {
    const { session } = sessionWith([['c1', 'Error: shown here'], ['c2', 'second']])
    expect(evidenceVisible(session, [evidence, { callId: 'c2', text: 'second' }])).toBe(true)
    expect(evidenceVisible(session, [{ callId: 'c3', text: 'x' }])).toBe(false)
  })

  it('fails once a result is replaced by a trimmed copy', () => {
    const { session, seqs } = sessionWith([['c1', 'shown']])
    const seq = seqs[0]!
    const original = session.events[seq]
    if (original?.type !== 'tool/result') throw new Error('expected the delivered result')
    const message = original.data.message
    // A pruner replacement keeps the message identity and changes only the result's content.
    session.append('tool/result', {
      turn: 1, step: 1, message: { ...message, content: [{ ...message.content[0], content: [{ type: 'text', text: 'sh[...]' }] }] },
    }, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] })
    expect(evidenceVisible(session, [evidence])).toBe(false)
  })
})
