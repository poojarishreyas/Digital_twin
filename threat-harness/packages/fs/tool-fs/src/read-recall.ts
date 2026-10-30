/**
 * Read recall over the observation ledger: decide whether a reader already holds the lines it asks
 * for (`file_unchanged`), can be brought current with only the changed hunks (`file_delta`), or
 * needs a full read, and compute the knowledge to record afterwards. Knowledge counts only while
 * every result that showed it is still on the reader's session surface with its text intact.
 * @module @elemental/tool-fs/src/read-recall
 */

import type { FsLineSpan, FsReadEvidence, FsReadKnowledge } from '@elemental/fs'
import type { Session } from '@elemental/session'
import { at, diffHunks, diffLines } from './line-diff.ts'
import type { DiffLine, DiffRun } from './line-diff.ts'

/** Unchanged lines shown on each side of a changed region in a delta. */
export const DELTA_CONTEXT = 2

/**
 * Split file text into lines as the read window numbers them: a trailing newline ends the last
 * line instead of starting another, and a trailing carriage return is not part of a line.
 * @param text - the complete file text.
 * @returns the file's lines, without terminators.
 */
export function textLines(text: string): string[] {
  if (text.length === 0) return []
  return text.replace(/\n$/u, '').split('\n').map(line => line.replace(/\r$/u, ''))
}

/**
 * Collapse ascending line numbers into spans.
 * @param numbers - 1-based line numbers, ascending and distinct.
 * @returns the maximal runs of consecutive numbers.
 */
export function spansOf(numbers: readonly number[]): FsLineSpan[] {
  const spans: { start: number; end: number }[] = []
  for (const number of numbers) {
    const last = spans.at(-1)
    if (last !== undefined && last.end + 1 === number) last.end = number
    else spans.push({ start: number, end: number })
  }
  return spans
}

/** Per-line flags (index 0 is line 1) for spans over a text of `lineCount` lines. */
function flags(spans: readonly FsLineSpan[], lineCount: number): Uint8Array {
  const seen = new Uint8Array(lineCount)
  for (const span of spans) seen.fill(1, span.start - 1, span.end)
  return seen
}

/** Line numbers whose flag is set. */
function flagged(seen: Uint8Array): number[] {
  const numbers: number[] = []
  seen.forEach((flag, index) => {
    if (flag === 1) numbers.push(index + 1)
  })
  return numbers
}

/**
 * Whether every evidence result is still on the session's model-visible surface with its text
 * intact. A pruned, spilled, summarized, or never-delivered result fails the check, so the reader
 * is served a full read instead of a pointer to text it no longer has.
 * @param session - the reader's session.
 * @param evidence - the results the knowledge rests on.
 * @returns true only when every result is visible and still contains its recorded text.
 */
export function evidenceVisible(session: Session, evidence: readonly FsReadEvidence[]): boolean {
  const visible = new Map<string, string>()
  for (const seq of session.surface.nodes) {
    const event = at(session.events, seq)
    if (event.type !== 'tool/result') continue
    const text = event.data.message.content[0].content.map(block => block.type === 'text' ? block.text : '').join('')
    visible.set(event.data.message.source.callId, text)
  }
  return evidence.every(item => visible.get(item.callId)?.includes(item.text) === true)
}

/** The reader holds every requested line already: answer with a pointer. */
export interface UnchangedRecall {
  /** Discriminant. */
  kind: 'unchanged'
  /** The requested lines, as spans. */
  spans: FsLineSpan[]
}

/** The file changed, but the reader can be brought current with the changed hunks. */
export interface DeltaRecall {
  /** Discriminant. */
  kind: 'delta'
  /** Line count of the text the reader knew. */
  previousTotalLines: number
  /** The changed regions with context, in file order. */
  hunks: DiffLine[][]
  /** Knowledge to record once the delta is delivered, minus this result's own evidence. */
  next: { seen: FsLineSpan[]; previous: readonly FsReadEvidence[] }
}

/**
 * Decide how to answer a read from what the reader already knows.
 * @param knowledge - the reader's recorded knowledge, already checked by {@link evidenceVisible}.
 * @param text - the file's current text.
 * @param requested - the lines the full read would show, ascending, in current numbering.
 * @param maxEdits - the most changed lines worth describing as a delta.
 * @returns an unchanged pointer, a delta, or `undefined` when only a full read serves.
 */
export function recallRead(
  knowledge: FsReadKnowledge,
  text: string,
  requested: readonly number[],
  maxEdits: number,
): UnchangedRecall | DeltaRecall | undefined {
  const before = textLines(knowledge.text)
  const seen = flags(knowledge.seen, before.length)
  if (knowledge.text === text) {
    return requested.every(line => seen[line - 1] === 1) ? { kind: 'unchanged', spans: spansOf(requested) } : undefined
  }
  const after = textLines(text)
  const runs = diffLines(before, after, maxEdits)
  if (runs === undefined) return undefined
  const { newToOld, nowSeen } = carry(runs, seen, after.length)
  // Every requested line must be either changed (the delta shows it) or unchanged and already seen.
  if (!requested.every(line => newToOld[line - 1] === 0 || nowSeen[line - 1] === 1)) return undefined
  const hunks = diffHunks(runs, before, after, DELTA_CONTEXT)
  for (const line of hunks.flat()) {
    if (line.newNumber !== undefined) nowSeen[line.newNumber - 1] = 1
  }
  return {
    kind: 'delta',
    previousTotalLines: before.length,
    hunks,
    next: { seen: spansOf(flagged(nowSeen)), previous: knowledge.evidence },
  }
}

/**
 * Map the reader's seen lines through an edit script into the new text.
 * @returns `newToOld` (the 1-based old line each new line came from, 0 for an inserted line) and
 *   the seen flags carried onto unchanged lines.
 */
function carry(runs: readonly DiffRun[], seen: Uint8Array, newLength: number): { newToOld: Int32Array; nowSeen: Uint8Array } {
  const newToOld = new Int32Array(newLength)
  const nowSeen = new Uint8Array(newLength)
  let oldLine = 0
  let newLine = 0
  for (const run of runs) {
    if (run.kind === 'equal') {
      for (let i = 0; i < run.count; i += 1) {
        newToOld[newLine + i] = oldLine + i + 1
        nowSeen[newLine + i] = at(seen, oldLine + i)
      }
    }
    if (run.kind !== 'insert') oldLine += run.count
    if (run.kind !== 'delete') newLine += run.count
  }
  return { newToOld, nowSeen }
}

/**
 * Knowledge after a full read: the shown lines merged into still-valid knowledge of the same
 * text, or fresh knowledge when there is none or when this read re-showed every known line.
 * @param prior - the reader's knowledge if its evidence is still visible.
 * @param text - the file text the read showed.
 * @param shown - lines the read showed in full, ascending.
 * @param evidence - this read's own result.
 * @returns the knowledge to record.
 */
export function knowledgeAfterRead(
  prior: FsReadKnowledge | undefined,
  text: string,
  shown: readonly number[],
  evidence: FsReadEvidence,
): FsReadKnowledge {
  if (prior?.text !== text) return { text, seen: spansOf(shown), evidence: [evidence] }
  const lineCount = textLines(text).length
  const shownFlags = flags(spansOf(shown), lineCount)
  // A read that re-showed everything already known replaces the older results as evidence, so
  // superseding or trimming those later does not discard the knowledge.
  if (prior.seen.every(span => shownFlags.subarray(span.start - 1, span.end).every(flag => flag === 1))) {
    return { text, seen: spansOf(shown), evidence: [evidence] }
  }
  const seen = flags(prior.seen, lineCount)
  for (const line of shown) seen[line - 1] = 1
  return { text, seen: spansOf(flagged(seen)), evidence: [...prior.evidence, evidence] }
}

/**
 * Render delta hunks: a header per hunk, then each line numbered — removed lines by their old
 * number, the rest by their current number.
 * @param hunks - the hunks from {@link recallRead}.
 * @returns the hunk block, one line per entry.
 */
export function formatHunks(hunks: readonly (readonly DiffLine[])[]): string {
  return hunks.map((lines) => {
    const olds = lines.filter(line => line.op !== '+')
    const news = lines.filter(line => line.op !== '-')
    const range = (side: readonly DiffLine[], key: 'oldNumber' | 'newNumber', fallback: number): string =>
      `${side[0]?.[key] ?? fallback},${side.length}`
    // An empty side is anchored after the line it follows, as unified diffs do.
    const anchor = (lines.find(line => line.op !== '-')?.newNumber ?? 1) - 1
    const header = `@@ -${range(olds, 'oldNumber', anchor)} +${range(news, 'newNumber', anchor)} @@`
    const body = lines.map(line => `${line.op}${line.op === '-' ? line.oldNumber : line.newNumber}: ${line.text}`)
    return [header, ...body].join('\n')
  }).join('\n')
}
