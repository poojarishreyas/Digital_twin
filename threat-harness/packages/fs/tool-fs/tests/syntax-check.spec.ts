/**
 * The syntax shadow check: which tree-sitter errors count as introduced by a change, and how
 * they are reported.
 */

import { describe, expect, it } from 'vitest'
import type { SyntaxNode } from '../src/read-fold.ts'
import { SyntaxParsers } from '../src/read-syntax.ts'
import {
  checkSyntax, formatSyntaxNotice, introducedProblems, shadowCheck, syntaxProblems, withSyntaxNotice,
} from '../src/syntax-check.ts'

const parsers = new SyntaxParsers()

const CLEAN = `export function total(values: number[]): number {
  let sum = 0
  for (const value of values) {
    sum += value
  }
  return sum
}
`

/** A minimal node for shapes a real grammar rarely produces. */
function node(fields: Partial<SyntaxNode> & { type: string }): SyntaxNode {
  return {
    text: '', startPosition: { row: 0 }, endPosition: { row: 0, column: 0 },
    namedChildren: [], children: [], firstChild: null, lastChild: null, parent: null,
    previousSibling: null, previousNamedSibling: null, isError: false, isMissing: false, hasError: false,
    childForFieldName: () => null,
    ...fields,
  }
}

describe('syntaxProblems', () => {
  it('reports missing tokens and unparsable text, outermost first, and skips clean subtrees', () => {
    const missingWord = node({ type: 'identifier', isMissing: true, startPosition: { row: 4 } })
    const blank = node({ type: 'ERROR', isError: true, text: '  \n  ', startPosition: { row: 6 } })
    const long = node({ type: 'ERROR', isError: true, text: `\n  ${'x'.repeat(50)}\n`, startPosition: { row: 8 } })
    const inner = node({ type: 'ERROR', isError: true, text: 'inner' })
    const outer = node({ type: 'ERROR', isError: true, text: 'outer', children: [inner], hasError: true, startPosition: { row: 9 } })
    const clean = node({ type: 'statement', children: [node({ type: 'ERROR', isError: true })] })
    const root = node({ type: 'program', hasError: true, children: [null, missingWord, clean, blank, long, outer] })
    expect(syntaxProblems(root)).toEqual([
      { line: 5, message: 'missing identifier' },
      { line: 7, message: 'syntax error' },
      { line: 9, message: `unexpected "${'x'.repeat(40)}…"` },
      { line: 10, message: 'unexpected "outer"' },
    ])
  })
})

describe('introducedProblems', () => {
  it('cancels each earlier problem against one identical message, wherever its line moved', () => {
    const before = [{ line: 3, message: 'missing "}"' }]
    const after = [{ line: 9, message: 'missing "}"' }, { line: 12, message: 'missing "}"' }, { line: 2, message: 'missing ")"' }]
    expect(introducedProblems(before, after)).toEqual([{ line: 12, message: 'missing "}"' }, { line: 2, message: 'missing ")"' }])
  })
})

describe('checkSyntax', () => {
  it('reports an unclosed brace a change introduced', async () => {
    const broken = CLEAN.replace('    sum += value\n  }\n', '    sum += value\n')
    expect(await checkSyntax(parsers, 'a.ts', CLEAN, broken, 1_000_000)).toEqual([{ line: 6, message: 'missing "}"' }])
  })

  it('ignores errors the file already had, and treats a new file as having none', async () => {
    const before = `${CLEAN}const broken = (\n`
    const after = before.replace('let sum = 0', 'let sum = 1')
    expect(await checkSyntax(parsers, 'a.ts', before, after, 1_000_000)).toEqual([])
    expect(await checkSyntax(parsers, 'a.py', null, 'def f(x)\n    return x\n', 1_000_000)).toEqual([{ line: 1, message: 'unexpected "def f(x)"' }])
  })

  it('skips clean results, unsupported languages, large files, and grammars that fail to load', async () => {
    expect(await checkSyntax(parsers, 'a.ts', null, CLEAN, 1_000_000)).toEqual([])
    expect(await checkSyntax(parsers, 'notes.md', null, '{{{', 1_000_000)).toEqual([])
    expect(await checkSyntax(parsers, 'a.ts', null, 'const a = (', 5)).toEqual([])
    expect(await checkSyntax(new SyntaxParsers('/nonexistent-grammar-dir'), 'a.ts', null, 'const a = (', 1_000_000)).toEqual([])
  })
})

describe('shadowCheck', () => {
  it('runs only when enabled', async () => {
    const config = { enabled: true, parsers, maxBytes: 1_000_000, maxListed: 3 }
    expect(await shadowCheck(config, 'a.ts', null, 'const a = (')).toHaveLength(1)
    expect(await shadowCheck({ ...config, enabled: false }, 'a.ts', null, 'const a = (')).toEqual([])
  })
})

describe('notices', () => {
  it('lists up to the limit and counts the rest', () => {
    expect(formatSyntaxNotice([{ line: 4, message: 'missing "}"' }], 3))
      .toBe('[Shadow check: this change introduced 1 syntax error. L4: missing "}". Fix it before editing other files or building.]')
    const three = [1, 2, 3].map(line => ({ line, message: 'missing ")"' }))
    expect(formatSyntaxNotice(three, 2))
      .toBe('[Shadow check: this change introduced 3 syntax errors. L1: missing ")"; L2: missing ")"; and 1 more. Fix them before editing other files or building.]')
  })

  it('appends the notice only when there are problems', () => {
    expect(withSyntaxNotice('Done.', undefined, 3)).toBe('Done.')
    expect(withSyntaxNotice('Done.', [{ line: 1, message: 'missing ")"' }], 3)).toMatch(/^Done\.\n\[Shadow check: /u)
  })
})
