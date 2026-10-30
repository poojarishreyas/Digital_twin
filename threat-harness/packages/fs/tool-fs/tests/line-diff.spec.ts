/**
 * Line diff behavior: shortest edit scripts that rebuild the new text, the edit budget, and
 * unified hunks with context, merged gaps, and empty sides.
 */

import { describe, expect, it } from 'vitest'
import { diffHunks, diffLines } from '../src/line-diff.ts'
import type { DiffRun } from '../src/line-diff.ts'
import { formatHunks } from '../src/read-recall.ts'

/** Replay an edit script over `before`, returning the new text it describes. */
function apply(runs: readonly DiffRun[], before: readonly string[], after: readonly string[]): string[] {
  const out: string[] = []
  let oldLine = 0
  let newLine = 0
  for (const run of runs) {
    if (run.kind === 'equal') out.push(...before.slice(oldLine, oldLine + run.count))
    if (run.kind === 'insert') out.push(...after.slice(newLine, newLine + run.count))
    if (run.kind !== 'insert') oldLine += run.count
    if (run.kind !== 'delete') newLine += run.count
  }
  expect(oldLine).toBe(before.length)
  return out
}

/** Edit distance by dynamic programming, the reference a shortest script must match. */
function distance(a: readonly string[], b: readonly string[]): number {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      lcs[i]![j] = a[i - 1] === b[j - 1] ? lcs[i - 1]![j - 1]! + 1 : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!)
    }
  }
  return a.length + b.length - 2 * lcs[a.length]![b.length]!
}

/** A deterministic pseudo-random line array over a small alphabet, so lines repeat. */
function lines(seed: number, length: number): string[] {
  let state = seed
  return Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return 'abcd'[state % 4]!
  })
}

describe('diffLines', () => {
  it('produces a shortest script that rebuilds the new lines', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const before = lines(seed, seed % 9)
      const after = lines(seed * 7 + 3, (seed * 5) % 11)
      const runs = diffLines(before, after, 100)
      if (runs === undefined) throw new Error('expected a script within budget')
      expect(apply(runs, before, after)).toEqual(after)
      const edits = runs.filter(run => run.kind !== 'equal').reduce((sum, run) => sum + run.count, 0)
      expect(edits).toBe(distance(before, after))
      expect(runs.every((run, i) => run.count > 0 && run.kind !== runs[i - 1]?.kind)).toBe(true)
    }
  })

  it('trims the shared head and tail and returns nothing to do for identical input', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'], 2)).toEqual([
      { kind: 'equal', count: 1 }, { kind: 'delete', count: 1 }, { kind: 'insert', count: 1 }, { kind: 'equal', count: 1 },
    ])
    expect(diffLines(['a'], ['a'], 0)).toEqual([{ kind: 'equal', count: 1 }])
    expect(diffLines([], [], 0)).toEqual([])
  })

  it('gives up when the change needs more edits than the budget', () => {
    expect(diffLines(['a', 'b'], ['c', 'd'], 3)).toBeUndefined()
    expect(diffLines(['a', 'b'], ['c', 'd'], 4)).toEqual([{ kind: 'delete', count: 2 }, { kind: 'insert', count: 2 }])
  })
})

describe('diffHunks', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']

  it('keeps context on both sides, bridges short gaps, and splits long ones', () => {
    const after = ['1', '2', 'x', '4', '5', 'y', '7', '8', '9', '10', '11', '12', 'z']
    const runs = diffLines(before, after, 20)
    if (runs === undefined) throw new Error('expected a script')
    expect(formatHunks(diffHunks(runs, before, after, 2))).toBe(`@@ -1,8 +1,8 @@
 1: 1
 2: 2
-3: 3
+3: x
 4: 4
 5: 5
-6: 6
+6: y
 7: 7
 8: 8
@@ -11,2 +11,3 @@
 11: 11
 12: 12
+13: z`)
  })

  it('anchors an empty side on the line before it', () => {
    const inserted = diffLines([], ['a', 'b'], 5)
    const removed = diffLines(['a', 'b'], [], 5)
    if (inserted === undefined || removed === undefined) throw new Error('expected scripts')
    expect(formatHunks(diffHunks(inserted, [], ['a', 'b'], 2))).toBe('@@ -0,0 +1,2 @@\n+1: a\n+2: b')
    expect(formatHunks(diffHunks(removed, ['a', 'b'], [], 2))).toBe('@@ -1,2 +0,0 @@\n-1: a\n-2: b')
    expect(diffHunks([{ kind: 'equal', count: 1 }], ['a'], ['a'], 2)).toEqual([])
  })
})
