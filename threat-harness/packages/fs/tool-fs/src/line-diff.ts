/**
 * Line diff for read deltas: a Myers shortest edit script over two line arrays and the unified
 * hunks it implies. Bounded by an edit budget so a rewrite costs no more than the full read it
 * would replace.
 * @module @elemental/tool-fs/src/line-diff
 */

/** One run of the edit script: lines kept, removed from the old text, or added in the new text. */
export interface DiffRun {
  /** What the run does. */
  kind: 'equal' | 'delete' | 'insert'
  /** Lines in the run; always positive. */
  count: number
}

/**
 * Read an index the caller has already bounds-checked; `noUncheckedIndexedAccess` cannot see the proof.
 * @param values - the array or typed array.
 * @param index - an in-range index.
 * @returns the element.
 */
export function at<T>(values: ArrayLike<T>, index: number): T {
  return values[index] as T
}

/** Append `count` lines of `kind`, extending the previous run when it has the same kind. */
function push(runs: DiffRun[], kind: DiffRun['kind'], count: number): void {
  if (count === 0) return
  const last = runs.at(-1)
  if (last?.kind === kind) last.count += count
  else runs.push({ kind, count })
}

/**
 * Compute a shortest edit script turning `before` into `after`, trimming the common head and tail
 * first so a local change costs only its own size.
 * @param before - the old lines.
 * @param after - the new lines.
 * @param maxEdits - the most inserted plus deleted lines worth describing.
 * @returns the runs in order, adjacent runs of one kind merged, or `undefined` when the change
 *   needs more than `maxEdits` edits.
 */
export function diffLines(before: readonly string[], after: readonly string[], maxEdits: number): DiffRun[] | undefined {
  let head = 0
  while (head < before.length && head < after.length && at(before, head) === at(after, head)) head += 1
  let tail = 0
  while (
    tail < before.length - head && tail < after.length - head
    && at(before, before.length - 1 - tail) === at(after, after.length - 1 - tail)
  ) tail += 1
  const middle = shortestEdit(before.slice(head, before.length - tail), after.slice(head, after.length - tail), maxEdits)
  if (middle === undefined) return undefined
  const runs: DiffRun[] = []
  push(runs, 'equal', head)
  for (const run of middle) push(runs, run.kind, run.count)
  push(runs, 'equal', tail)
  return runs
}

/**
 * Myers' O(ND) search. Round `d` snapshots the frontier over diagonals `-d-1 … d+1`, which is all
 * the backtrack reads, so memory grows with the edit distance squared rather than the file length.
 */
function shortestEdit(a: readonly string[], b: readonly string[], maxEdits: number): DiffRun[] | undefined {
  const limit = Math.min(a.length + b.length, maxEdits)
  const offset = limit + 1
  const frontier = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d += 1) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && at(frontier, offset + k - 1) < at(frontier, offset + k + 1))
      let x = down ? at(frontier, offset + k + 1) : at(frontier, offset + k - 1) + 1
      let y = x - k
      while (x < a.length && y < b.length && at(a, x) === at(b, y)) {
        x += 1
        y += 1
      }
      frontier[offset + k] = x
      if (x >= a.length && y >= b.length) return backtrack(trace, a.length, b.length)
    }
  }
  return undefined
}

/** Walk the snapshots from the end back to the start, then emit the runs in forward order. */
function backtrack(trace: readonly Int32Array[], n: number, m: number): DiffRun[] {
  const steps: DiffRun['kind'][] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const snapshot = at(trace, d)
    // Snapshot index i holds diagonal i - d - 1.
    const diagonal = (k: number): number => at(snapshot, k + d + 1)
    const k = x - y
    const down = k === -d || (k !== d && diagonal(k - 1) < diagonal(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = diagonal(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      steps.push('equal')
      x -= 1
      y -= 1
    }
    steps.push(down ? 'insert' : 'delete')
    x = prevX
    y = prevY
  }
  // Round 0's snake from the origin is empty: `diffLines` trims the common head before searching.
  const runs: DiffRun[] = []
  for (const kind of steps.reverse()) push(runs, kind, 1)
  return runs
}

/** One line of a unified hunk. */
export interface DiffLine {
  /** `' '` unchanged, `'-'` removed, `'+'` added. */
  op: ' ' | '-' | '+'
  /** 1-based line in the old text; absent for an added line. */
  oldNumber?: number
  /** 1-based line in the new text; absent for a removed line. */
  newNumber?: number
  /** The line's text. */
  text: string
}

/**
 * Group an edit script into unified hunks with `context` unchanged lines on each side, merging
 * changes separated by at most `2 * context` unchanged lines.
 * @param runs - the edit script from {@link diffLines}.
 * @param before - the old lines.
 * @param after - the new lines.
 * @param context - unchanged lines kept on each side of a change.
 * @returns each hunk's lines, in file order; empty when nothing changed.
 */
export function diffHunks(runs: readonly DiffRun[], before: readonly string[], after: readonly string[], context: number): DiffLine[][] {
  const hunks: DiffLine[][] = []
  let open: DiffLine[] | undefined
  let oldLine = 0
  let newLine = 0
  const keep = (target: DiffLine[], count: number): void => {
    for (let i = 0; i < count; i += 1) {
      target.push({ op: ' ', oldNumber: oldLine + i + 1, newNumber: newLine + i + 1, text: at(after, newLine + i) })
    }
  }
  runs.forEach((run, index) => {
    if (run.kind === 'equal') {
      if (open !== undefined) {
        // A gap short enough to bridge keeps the hunk open; otherwise it closes after `context` lines.
        const bridge = index < runs.length - 1 && run.count <= 2 * context
        keep(open, bridge ? run.count : Math.min(run.count, context))
        if (!bridge) {
          hunks.push(open)
          open = undefined
        }
      }
      oldLine += run.count
      newLine += run.count
      return
    }
    if (open === undefined) {
      open = []
      const back = Math.min(context, newLine)
      oldLine -= back
      newLine -= back
      keep(open, back)
      oldLine += back
      newLine += back
    }
    for (let i = 0; i < run.count; i += 1) {
      if (run.kind === 'delete') open.push({ op: '-', oldNumber: oldLine + i + 1, text: at(before, oldLine + i) })
      else open.push({ op: '+', newNumber: newLine + i + 1, text: at(after, newLine + i) })
    }
    if (run.kind === 'delete') oldLine += run.count
    else newLine += run.count
  })
  if (open !== undefined) hunks.push(open)
  return hunks
}
