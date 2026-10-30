/**
 * Elastic-read planning over the bundled tree-sitter grammars: folds, symbol resolution, and the
 * window-versus-folded decision, asserted on the visible lines a model would receive.
 */

import { describe, expect, it, vi } from 'vitest'
import { planRead } from '../src/read-elastic.ts'
import type { ElasticCaps, ElasticRequest, ReadPlan } from '../src/read-elastic.ts'
import { listDeclarations, matchSymbol, planFolds } from '../src/read-fold.ts'
import type { LineSpan } from '../src/read-fold.ts'
import { formatElasticOutput } from '../src/read-render.ts'
import { declarationScopes, innermostScope } from '../src/scopes.ts'
import { grammarForPath, SyntaxParsers } from '../src/read-syntax.ts'
import type { GrammarName } from '../src/read-syntax.ts'

const parsers = new SyntaxParsers()

/** Parse `source`, plan folds for `focus`, and return the rendered visible text (markers included). */
async function fold(grammar: GrammarName, source: string, focus: LineSpan[]): Promise<string> {
  const parsed = await parsers.parse(grammar, source)
  try {
    // Match the read window's line model: a trailing newline ends the last line, not a new one.
    const lines = (source.endsWith('\n') ? source.slice(0, -1) : source).split('\n')
    const folds = planFolds(parsed.root, lines, focus)
    const visible = lines
      .map((text, index) => ({ number: index + 1, text }))
      .filter(line => !folds.some(span => line.number >= span.start && line.number <= span.end))
    const body = formatElasticOutput('f', { lines: visible, totalLines: lines.length, folds, focus })
    // Blank lines render as `N: `; trim that trailing space so expectations stay whitespace-clean.
    return body.slice(body.indexOf('<content>\n') + 10, body.indexOf('\n\n(Folded view')).replace(/ +$/gmu, '')
  } finally {
    parsed.dispose()
  }
}

async function declarations(grammar: GrammarName, source: string) {
  const parsed = await parsers.parse(grammar, source)
  try {
    return listDeclarations(parsed.root)
  } finally {
    parsed.dispose()
  }
}

const TS_SOURCE = `import { a } from './a.ts'

/** Shape of a thing. */
export interface Thing {
  id: string
}

/**
 * Compute the total.
 * Longer explanation that folds away.
 */
export function total(values: number[]): number {
  let sum = 0
  for (const value of values) sum += value
  return sum
}

export class Store {
  private items: Thing[] = []

  @logged
  add(
    item: Thing,
  ): void {
    this.items.push(item)
    this.items.sort()
  }

  get size(): number {
    return this.items.length
  }
}

useEffect(() => {
  subscribe()
  return unsubscribe
}, [dep])

const tiny = () => {
  return 1
}
`

describe('planFolds', () => {
  it('folds bodies outside the focus to signature, marker, and closing line, keeping imports and types', async () => {
    expect(await fold('typescript', TS_SOURCE, [{ start: 29, end: 31 }])).toBe(`1: import { a } from './a.ts'
2:
3: /** Shape of a thing. */
4: export interface Thing {
5:   id: string
6: }
7:
8: /**
9:  * Compute the total.
⋯ [L10-L11 folded: 2 lines]
12: export function total(values: number[]): number {
⋯ [L13-L15 folded: 3 lines]
16: }
17:
18: export class Store {
19:   private items: Thing[] = []
20:
21:   @logged
22:   add(
23:     item: Thing,
24:   ): void {
⋯ [L25-L26 folded: 2 lines]
27:   }
28:
29:   get size(): number {
30:     return this.items.length
31:   }
32: }
33:
34: useEffect(() => {
⋯ [L35-L36 folded: 2 lines]
37: }, [dep])
38:
39: const tiny = () => {
40:   return 1
41: }`)
  })

  it('shows a focused declaration in full and folds only its nested bodies outside the focus', async () => {
    const source = `describe('suite', () => {
  it('first', () => {
    one()
    two()
  })
  it('second', () => {
    three()
    four()
  })
})`
    expect(await fold('typescript', source, [{ start: 6, end: 9 }])).toBe(`1: describe('suite', () => {
2:   it('first', () => {
⋯ [L3-L4 folded: 2 lines]
5:   })
6:   it('second', () => {
7:     three()
8:     four()
9:   })
10: })`)
  })

  it('folds an indentation block after its header, keeping a docstring summary and collapsing comment banners', async () => {
    const source = `# =====
# Helpers
# =====
VERSION = 1
# -----
# -----
# -----

class Greeter:
    """Say hello.

    More detail.
    """

    def greet(self, name):
        # a comment before the body
        message = "hi " + name
        return message

    def wave(self):
        """Wave a hand."""
        lift()
        shake()
`
    expect(await fold('python', source, [{ start: 1000, end: 1000 }])).toBe(`1: # =====
2: # Helpers
3: # =====
4: VERSION = 1
⋯ [L5-L6 folded: 2 lines]
7: # -----
8:
9: class Greeter:
10:     """Say hello.
⋯ [L11-L13 folded: 3 lines]
14:
15:     def greet(self, name):
⋯ [L16-L18 folded: 3 lines]
19:
20:     def wave(self):
21:         """Wave a hand."""
⋯ [L22-L23 folded: 2 lines]`)
  })

  it('collapses line-comment runs that end on a newline and folds Rust impl methods', async () => {
    const source = `/// Adds numbers.
/// Second line.
/// Third line.
fn add(a: i32, b: i32) -> i32 {
    let s = a + b;
    s
}

impl Point {
    fn norm(&self) -> f64 {
        let sq = self.x * self.x;
        sq.sqrt()
    }
}
`
    expect(await fold('rust', source, [{ start: 1000, end: 1000 }])).toBe(`1: /// Adds numbers.
⋯ [L2-L3 folded: 2 lines]
4: fn add(a: i32, b: i32) -> i32 {
⋯ [L5-L6 folded: 2 lines]
7: }
8:
9: impl Point {
10:     fn norm(&self) -> f64 {
⋯ [L11-L12 folded: 2 lines]
13:     }
14: }`)
  })

  it('keeps bodiless method declarations and folds Java constructors and Go functions', async () => {
    const java = `interface Shape {
    double area();
}
class Circle {
    Circle(double r) {
        this.r = r;
        check();
    }
}`
    expect(await fold('java', java, [{ start: 1000, end: 1000 }])).toBe(`1: interface Shape {
2:     double area();
3: }
4: class Circle {
5:     Circle(double r) {
⋯ [L6-L7 folded: 2 lines]
8:     }
9: }`)
    const go = `package main

func (s *Server) Serve(l Listener) error {
	defer l.Close()
	return s.loop(l)
}`
    expect(await fold('go', go, [{ start: 1000, end: 1000 }])).toBe(`1: package main
2:
3: func (s *Server) Serve(l Listener) error {
⋯ [L4-L5 folded: 2 lines]
6: }`)
  })

  it('keeps an expression body\'s last row, which may carry the enclosing call\'s tail', async () => {
    const source = `const value = useMemo(() => compute(
  first,
  second,
), [first])
const id = (v: number) => v`
    expect(await fold('typescript', source, [{ start: 1000, end: 1000 }])).toBe(`1: const value = useMemo(() => compute(
⋯ [L2-L3 folded: 2 lines]
4: ), [first])
5: const id = (v: number) => v`)
  })

  it('never hides a focused comment', async () => {
    const source = `/**
 * Summary.
 * Detail.
 */
const x = 1
// first
// second

// third
// fourth`
    expect(await fold('typescript', source, [{ start: 2, end: 2 }])).toBe(`1: /**
2:  * Summary.
3:  * Detail.
4:  */
5: const x = 1
6: // first
7: // second
8:
9: // third
10: // fourth`)
  })
})

describe('symbols', () => {
  it('lists dotted declarations whose spans include wrappers, decorators, attributes, and leading comments', async () => {
    const found = await declarations('typescript', TS_SOURCE)
    expect(found.map(d => [d.qualifiedName, d.span.start, d.span.end])).toEqual([
      ['Thing', 3, 6],
      ['total', 8, 16],
      ['Store', 18, 32],
      ['Store.items', 19, 19],
      ['Store.add', 21, 27],
      ['Store.size', 29, 31],
      ['tiny', 39, 41],
    ])
    const detached = await declarations('typescript', '// unrelated note\n\nfunction g() {}\n')
    expect(detached.map(d => d.span)).toEqual([{ start: 3, end: 3 }])
    // The signature line skips leading comments and decorators.
    expect(found.find(d => d.qualifiedName === 'Store.add')?.line).toBe(22)
    const rust = await declarations('rust', '#[derive(Debug)]\nstruct P { x: i32 }\nimpl P {\n    fn new() -> P { P { x: 0 } }\n}\n')
    expect(rust.map(d => [d.qualifiedName, d.span.start, d.span.end])).toEqual([['P', 1, 2], ['P', 3, 5], ['P.new', 4, 4]])
  })

  it('prefers an exact dotted name, then matches every trailing segment', async () => {
    const found = await declarations('typescript', 'function size() {}\nclass A { size() {} }\nclass B { size() {} }\n')
    expect(matchSymbol(found, 'size').map(d => d.qualifiedName)).toEqual(['size'])
    expect(matchSymbol(found, 'A.size').map(d => d.qualifiedName)).toEqual(['A.size'])
    const methods = await declarations('typescript', 'class A { size() {} }\nclass B { size() {} }\n')
    expect(matchSymbol(methods, 'size').map(d => d.qualifiedName)).toEqual(['A.size', 'B.size'])
    expect(matchSymbol(methods, 'missing')).toEqual([])
  })
})

describe('grammarForPath', () => {
  it('maps extensions case-insensitively and declines dotfiles, unknown and prototype-key extensions', () => {
    expect(grammarForPath('/a/b.TS')).toBe('typescript')
    expect(grammarForPath('C:\\src\\view.tsx')).toBe('tsx')
    expect(grammarForPath('lib.mjs')).toBe('javascript')
    expect(grammarForPath('stub.pyi')).toBe('python')
    expect(grammarForPath('.gitignore')).toBeUndefined()
    expect(grammarForPath('Makefile')).toBeUndefined()
    expect(grammarForPath('notes.md')).toBeUndefined()
    expect(grammarForPath('x.constructor')).toBeUndefined()
  })
})

describe('SyntaxParsers', () => {
  it('retries a grammar whose file failed to load instead of caching the failure', async () => {
    const missing = new SyntaxParsers('/nonexistent-grammar-dir')
    await expect(missing.parse('go', 'package main')).rejects.toThrow(/ENOENT/)
    await expect(missing.parse('go', 'package main')).rejects.toThrow(/ENOENT/)
  })

})

/** A TypeScript file of 3 header lines, then `count` four-line functions: `f<i>` spans lines 4 + 4i to 7 + 4i. */
function bigSource(count: number, extra = ''): string {
  const fns = Array.from({ length: count }, (_, i) => `function f${i}() {\n  step(${i})\n  step(${i})\n}\n`)
  return `import x from 'x'\n${extra}\n\n${fns.join('')}`
}

const CAPS: ElasticCaps = { limit: 2000, maxLineLength: 2000, maxBytes: 50 * 1024, foldWindows: true, foldMinLines: 20 }

function request(overrides: Partial<ElasticRequest>): ElasticRequest {
  return { offset: 1, limit: 2000, windowed: false, fold: true, ...overrides }
}

describe('planRead', () => {
  const source = bigSource(10)

  it('reads plainly without a focus, with fold=false, with window folding off, or for an unsupported file', async () => {
    const window: ReadPlan = { kind: 'window', offset: 5, limit: 3 }
    expect(await planRead(parsers, source, 'a.ts', request({}), CAPS)).toEqual({ kind: 'window', offset: 1, limit: 2000 })
    expect(await planRead(parsers, source, 'a.ts', request({ offset: 5, limit: 3, windowed: true, fold: false }), CAPS)).toEqual(window)
    expect(await planRead(parsers, source, 'a.ts', request({ offset: 5, limit: 3, windowed: true }), { ...CAPS, foldWindows: false })).toEqual(window)
    expect(await planRead(parsers, source, 'a.txt', request({ offset: 5, limit: 3, windowed: true }), CAPS)).toEqual(window)
  })

  it('reads a short file or an out-of-range window plainly', async () => {
    expect(await planRead(parsers, source, 'a.ts', request({ offset: 5, limit: 3, windowed: true }), { ...CAPS, foldMinLines: 1000 }))
      .toEqual({ kind: 'window', offset: 5, limit: 3 })
    expect(await planRead(parsers, source, 'a.ts', request({ offset: 999, windowed: true }), CAPS))
      .toEqual({ kind: 'window', offset: 999, limit: 2000 })
  })

  it('folds a window of a long source file around the requested lines', async () => {
    const plan = await planRead(parsers, source, 'a.ts', request({ offset: 10, limit: 4, windowed: true }), CAPS)
    if (plan.kind !== 'elastic') throw new Error('expected a folded view')
    // f1 (8-11) and f2 (12-15) touch the window and stay whole; every other body folds.
    expect(plan.focus).toEqual([{ start: 10, end: 13 }])
    expect(plan.totalLines).toBe(43)
    expect(plan.folds).toEqual([5, 17, 21, 25, 29, 33, 37, 41].map(start => ({ start, end: start + 1 })))
    expect(plan.lines.map(line => line.number).slice(0, 16)).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20])
  })

  it('reads a window plainly when the parser cannot load, but reports the failure to a symbol read', async () => {
    const broken = new SyntaxParsers('/nonexistent-grammar-dir')
    expect(await planRead(broken, source, 'a.ts', request({ offset: 10, limit: 4, windowed: true }), CAPS))
      .toEqual({ kind: 'window', offset: 10, limit: 4 })
    await expect(planRead(broken, source, 'a.ts', request({ symbol: 'f1' }), CAPS)).rejects.toThrow(/ENOENT/)
  })

  it('reads a window plainly when nothing outside it folds', async () => {
    const flat = `${Array.from({ length: 30 }, (_, i) => `const v${i} = ${i}`).join('\n')}\n`
    expect(await planRead(parsers, flat, 'a.ts', request({ offset: 3, limit: 2, windowed: true }), CAPS))
      .toEqual({ kind: 'window', offset: 3, limit: 2 })
  })

  it('folds every other declaration around a symbol, regardless of file length', async () => {
    const plan = await planRead(parsers, bigSource(2), 'a.ts', request({ symbol: 'f1' }), { ...CAPS, foldMinLines: 1000 })
    expect(plan).toEqual({
      kind: 'elastic',
      lines: [
        { number: 1, text: 'import x from \'x\'' }, { number: 2, text: '' }, { number: 3, text: '' },
        { number: 4, text: 'function f0() {' }, { number: 7, text: '}' },
        { number: 8, text: 'function f1() {' }, { number: 9, text: '  step(1)' }, { number: 10, text: '  step(1)' }, { number: 11, text: '}' },
      ],
      totalLines: 11,
      folds: [{ start: 5, end: 6 }],
      focus: [{ start: 8, end: 11 }],
    })
  })

  it('merges the spans of every matching declaration into the focus', async () => {
    const twin = 'class A {\n  run() {\n    a()\n    b()\n  }\n}\nclass B {\n  run() {\n    a()\n    b()\n  }\n  stop() {\n    a()\n    b()\n  }\n}\n'
    const plan = await planRead(parsers, twin, 'a.ts', request({ symbol: 'run' }), CAPS)
    if (plan.kind !== 'elastic') throw new Error('expected a folded view')
    expect(plan.focus).toEqual([{ start: 2, end: 5 }, { start: 8, end: 11 }])
    expect(plan.folds).toEqual([{ start: 13, end: 14 }])
    const adjacent = 'function a() {\n  x()\n  y()\n}\nfunction a() {\n  x()\n  y()\n}\nfunction b() {\n  x()\n  y()\n}\n'
    const merged = await planRead(parsers, adjacent, 'a.ts', request({ symbol: 'a' }), CAPS)
    if (merged.kind !== 'elastic') throw new Error('expected a folded view')
    expect(merged.focus).toEqual([{ start: 1, end: 8 }])
  })

  it('serves a symbol as a plain window when asked for raw lines, when it exceeds one read, or when nothing else folds', async () => {
    const two = bigSource(2)
    expect(await planRead(parsers, two, 'a.ts', request({ symbol: 'f1', fold: false }), CAPS)).toEqual({ kind: 'window', offset: 8, limit: 4 })
    expect(await planRead(parsers, two, 'a.ts', request({ symbol: 'f1' }), { ...CAPS, limit: 3 })).toEqual({ kind: 'window', offset: 8, limit: 3 })
    expect(await planRead(parsers, 'function only() {\n  a()\n  b()\n}\n', 'a.ts', request({ symbol: 'only' }), CAPS))
      .toEqual({ kind: 'window', offset: 1, limit: 4 })
  })

  it('falls back to the plain window when the folded view exceeds the byte cap', async () => {
    const long = bigSource(10, `const banner = '${'x'.repeat(200)}'`)
    const capped = { ...CAPS, maxBytes: 150 }
    expect(await planRead(parsers, long, 'a.ts', request({ offset: 10, limit: 4, windowed: true }), capped))
      .toEqual({ kind: 'window', offset: 10, limit: 4 })
    expect(await planRead(parsers, long, 'a.ts', request({ symbol: 'f3' }), capped)).toEqual({ kind: 'window', offset: 16, limit: 4 })
  })

  it('rejects a symbol in an unsupported file or one the file does not declare, listing what it does declare', async () => {
    await expect(planRead(parsers, 'text', 'notes.md', request({ symbol: 'x' }), CAPS))
      .rejects.toThrow('symbol focus is not available for "notes.md": it supports .ts, .mts, .cts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyi, .go, .rs, .java files. Use offset and limit instead.')
    await expect(planRead(parsers, bigSource(2), 'a.ts', request({ symbol: 'nope' }), CAPS))
      .rejects.toThrow('symbol "nope" was not found in "a.ts"; declared symbols: f0, f1.')
    await expect(planRead(parsers, bigSource(45), 'a.ts', request({ symbol: 'nope' }), CAPS))
      .rejects.toThrow(/declared symbols: f0, f1, .*, f39, … \(5 more\)\.$/u)
    await expect(planRead(parsers, 'a()\n', 'a.ts', request({ symbol: 'nope' }), CAPS))
      .rejects.toThrow('symbol "nope" was not found in "a.ts"; it declares no named symbols.')
  })

  it('outlines a file by folding every body, whatever its length', async () => {
    expect(await planRead(parsers, bigSource(2), 'a.ts', request({ outline: true }), { ...CAPS, foldMinLines: 1000 })).toEqual({
      kind: 'elastic',
      lines: [
        { number: 1, text: 'import x from \'x\'' }, { number: 2, text: '' }, { number: 3, text: '' },
        { number: 4, text: 'function f0() {' }, { number: 7, text: '}' },
        { number: 8, text: 'function f1() {' }, { number: 11, text: '}' },
      ],
      totalLines: 11,
      folds: [{ start: 5, end: 6 }, { start: 9, end: 10 }],
      focus: [],
      declarations: [{ qualifiedName: 'f0', span: { start: 4, end: 7 }, line: 4 }, { qualifiedName: 'f1', span: { start: 8, end: 11 }, line: 8 }],
    })
  })

  it('outlines a file with nothing to fold as all of its lines', async () => {
    expect(await planRead(parsers, 'const a = 1\nconst b = 2\n', 'a.ts', request({ outline: true }), CAPS)).toEqual({
      kind: 'elastic',
      lines: [{ number: 1, text: 'const a = 1' }, { number: 2, text: 'const b = 2' }],
      totalLines: 2,
      folds: [],
      focus: [],
      declarations: [{ qualifiedName: 'a', span: { start: 1, end: 1 }, line: 1 }, { qualifiedName: 'b', span: { start: 2, end: 2 }, line: 2 }],
    })
  })

  it('rejects an outline of an unsupported file or one above the byte cap, saying what to read instead', async () => {
    await expect(planRead(parsers, 'text', 'notes.md', request({ outline: true }), CAPS))
      .rejects.toThrow(/^an outline is not available for "notes.md": it supports \.ts, .* files\. Use offset and limit instead\.$/u)
    const bannered = bigSource(10, `const banner = '${'x'.repeat(200)}'`)
    await expect(planRead(parsers, bannered, 'a.ts', request({ outline: true }), { ...CAPS, maxBytes: 150 }))
      .rejects.toThrow(new RegExp('^the outline of "a\\.ts" is \\d+ bytes, above the 150-byte read cap\\. '
        + 'Read a declaration with symbol, or a range with offset and limit\\.$', 'u'))
  })

  it('releases the parsed tree whether planning succeeds or throws', async () => {
    const dispose = vi.fn()
    const parse = vi.spyOn(parsers, 'parse')
    for (const symbol of ['f0', 'nope']) {
      const parsed = await new SyntaxParsers().parse('typescript', bigSource(2))
      parse.mockResolvedValueOnce({ root: parsed.root, dispose: () => { dispose(); parsed.dispose() } })
      await planRead(parsers, bigSource(2), 'a.ts', request({ symbol }), CAPS).catch(() => undefined)
    }
    parse.mockRestore()
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})

describe('formatElasticOutput', () => {
  it('places markers between lines and after the last line, and names the focus in the footer', () => {
    const text = formatElasticOutput('/abs/a.ts', {
      lines: [{ number: 1, text: 'a' }, { number: 4, text: 'd' }],
      totalLines: 6,
      folds: [{ start: 2, end: 3 }, { start: 5, end: 6 }],
      focus: [{ start: 4, end: 4 }],
    })
    expect(text).toBe(`<path>/abs/a.ts</path>
<type>file</type>
<content>
1: a
⋯ [L2-L3 folded: 2 lines]
4: d
⋯ [L5-L6 folded: 2 lines]

(Folded view of 6 lines: lines 4 shown in full; 4 lines in 2 folded regions. Each folded region keeps its line span; read it with offset and limit, or pass fold=false for raw lines.)
</content>`)
    expect(formatElasticOutput('a.ts', { lines: [], totalLines: 0, folds: [], focus: [{ start: 1, end: 3 }] }, 'Store.add'))
      .toContain('(Folded view of 0 lines: Store.add (lines 1-3) shown in full; 0 lines in 0 folded regions.')
  })

  it('names an outline in the footer when nothing is in focus', () => {
    const text = formatElasticOutput('a.ts', { lines: [{ number: 1, text: 'a' }], totalLines: 3, folds: [{ start: 2, end: 3 }], focus: [] })
    expect(text).toContain('⋯ [L2-L3 folded: 2 lines]\n\n(Outline of 3 lines: 2 lines in 1 folded regions. '
      + 'Read a declaration in full with symbol, or a folded region with offset and limit.)\n</content>')
  })
})

describe('declaration scopes', () => {
  it('lists each declaration with its signature line and finds the innermost one containing a line', async () => {
    const scopes = await declarationScopes('a.ts', TS_SOURCE)
    if (scopes === undefined) throw new Error('expected scopes')
    expect(scopes.find(scope => scope.name === 'Store.add')).toEqual({ name: 'Store.add', start: 22, end: 27, header: 'add(' })
    expect(innermostScope(scopes, 26)?.name).toBe('Store.add')
    expect(innermostScope(scopes, 19)?.name).toBe('Store.items')
    expect(innermostScope(scopes, 20)?.name).toBe('Store')
    expect(innermostScope(scopes, 1)).toBeUndefined()
  })

  it('has no scopes for an unsupported language or a grammar that fails to load', async () => {
    expect(await declarationScopes('notes.md', '# title')).toBeUndefined()
    const parse = vi.spyOn(SyntaxParsers.prototype, 'parse').mockRejectedValueOnce(new Error('no grammar'))
    expect(await declarationScopes('a.ts', 'const a = 1')).toBeUndefined()
    parse.mockRestore()
  })
})
