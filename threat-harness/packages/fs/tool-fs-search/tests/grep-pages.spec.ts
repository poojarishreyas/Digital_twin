/**
 * The `grep` additions: ripgrep flags for case, file type, and context; paging with
 * `head_limit` and `offset`; context lines in a `lines` page; and the enclosing-declaration
 * headers read through `ctx.fs`. Ripgrep is scripted through a fake subprocess runtime.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import { FileSystem, FsTargetKey, FsVersion } from '@elemental/fs'
import type { FsInfo, FsTarget } from '@elemental/fs'
import { ToolCallId } from '@elemental/llm'
import { SubprocessRuntime } from '@elemental/subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@elemental/subprocess'
import SystemPrompt from '@elemental/system-prompt'
import ToolRuntime from '@elemental/tools'
import type { ContentBlock } from '@elemental/llm'
import * as ToolFsSearch from '@elemental/tool-fs-search'
import { buildGrepCommand, formatGrepFiles, formatGrepLines, parseGrepArgs, parseGrepPage, parseGrepRecords } from '@elemental/tool-fs-search'

/** A runtime whose every spawn exits 0 (or 1 for an empty script) with the scripted stdout. */
class ScriptedSubprocess extends SubprocessRuntime {
  stdout = ''
  spawns: SubprocessSpawnSpec[] = []
  override async resolveExecutable(command: string): Promise<string> { return command }
  override spawnTerminal(): Promise<never> { throw new Error('unused') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const text = this.stdout
    const reader = (value: string) => ({ readFrom: () => ({ text: value, nextOffset: value.length, lossy: false }) })
    return {
      pid: 1, stdin: undefined, stdout: undefined, stderr: undefined,
      collected: { stdout: reader(text), stderr: reader('') },
      done: Promise.resolve({ exitCode: text.length === 0 ? 1 : 0, signal: null }),
      terminate: () => { },
      waitForExit: () => Promise.resolve(true),
    }
  }
}

/** An in-memory filesystem keyed by absolute path; `size` can be overridden to exercise the parse cap. */
// @ts-expect-error -- only resolve, stat, and readText are called by grep.
class MemoryFs extends FileSystem {
  files = new Map<string, string>()
  size: number | undefined = undefined
  failRead = false
  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const text = this.files.get(target.targetKey)
    if (text === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', ...this.size === undefined ? { size: text.length } : this.size < 0 ? {} : { size: this.size } }
  }
  override async readText(target: FsTarget): Promise<string> {
    if (this.failRead) throw new Error('unreadable')
    return this.files.get(target.targetKey) ?? ''
  }
}

function record(type: 'match' | 'context', path: string, lineNumber: number, text: string): string {
  return JSON.stringify({ type, data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: lineNumber } })
}

async function setup(config: Partial<ToolFsSearch.Config> = {}, withFs = true) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptedSubprocess)
  if (withFs) await ctx.plugin(MemoryFs)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true, ...config })
  const subprocess = ctx.subprocess as ScriptedSubprocess
  const fs = withFs ? ctx.get('fs') as MemoryFs : undefined
  let n = 0
  const grep = async (args: object): Promise<string> => {
    const result = await ctx.tools.execute({
      callId: ToolCallId(`g${++n}`), name: 'grep', arguments: args, signal: new AbortController().signal,
      agent: { session: { header: { id: 's', cwd: '/w' } } } as never,
    })
    return result.content.map((block: ContentBlock) => block.type === 'text' ? block.text : '').join('')
  }
  return { ctx, subprocess, fs, grep }
}

const SOURCE = `import { a } from './a.ts'

export function executeGrep(opts: GrepOpts) {
  const results = run(opts)
  return results.slice(0, limit)
}

export class Store {
  add(item: Thing): void {
    this.items.push(limit)
  }
}
const top = limit
`

describe('grep arguments', () => {
  it('builds case, type, and context flags', () => {
    const input = parseGrepArgs({ pattern: 'x', ignore_case: true, type: 'ts', context: 2, after_context: 0, output: 'lines' })
    expect(input).toEqual({ pattern: 'x', ignoreCase: true, type: 'ts', before: 2 })
    expect(buildGrepCommand(input)).toEqual(['--json', '--regexp=x', '--ignore-case', '--type=ts', '--before-context=2'])
    expect(parseGrepArgs({ pattern: 'x', ignore_case: false, before_context: 1, after_context: 3, output: 'lines' }))
      .toEqual({ pattern: 'x', before: 1, after: 3 })
  })

  it('rejects bad types, out-of-range context, and context outside lines output', () => {
    expect(() => parseGrepArgs({ pattern: 'x', type: 'ts,js' })).toThrow(/type must be one ripgrep file type name/)
    expect(() => parseGrepArgs({ pattern: 'x', context: 6, output: 'lines' })).toThrow('context must be an integer from 0 to 5')
    expect(() => parseGrepArgs({ pattern: 'x', after_context: 1.5, output: 'lines' })).toThrow('after_context must be an integer from 0 to 5')
    expect(() => parseGrepArgs({ pattern: 'x', before_context: -1, output: 'lines' })).toThrow('before_context must be an integer from 0 to 5')
    expect(() => parseGrepArgs({ pattern: 'x', context: 1 })).toThrow('context lines apply only to output "lines"')
  })

  it('pages from 0 by the default head limit, within the configured maximum', () => {
    expect(parseGrepPage({})).toEqual({ offset: 0, limit: 100 })
    expect(parseGrepPage({ head_limit: 7, offset: 14 })).toEqual({ offset: 14, limit: 7 })
    expect(parseGrepPage({}, { maxContextLines: 5, maxHeadLimit: 20, defaultHeadLimit: 100 })).toEqual({ offset: 0, limit: 20 })
    expect(() => parseGrepPage({ head_limit: 251 })).toThrow('head_limit must be an integer from 1 to 250')
    expect(() => parseGrepPage({ head_limit: 0 })).toThrow('head_limit must be an integer from 1 to 250')
    expect(() => parseGrepPage({ offset: -1 })).toThrow('offset must be a non-negative integer')
    expect(() => parseGrepPage({ offset: 0.5 })).toThrow('offset must be a non-negative integer')
  })

  it('parses context records apart from matches', () => {
    const stdout = [record('context', 'a.ts', 1, 'before'), record('match', 'a.ts', 2, 'hit'), JSON.stringify({ type: 'end', data: {} })].join('\n')
    expect(parseGrepRecords(stdout)).toEqual({
      matches: [{ path: 'a.ts', lineNumber: 2, line: 'hit' }],
      context: [{ path: 'a.ts', lineNumber: 1, line: 'before' }],
    })
  })
})

describe('grep pages', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i % 3}.ts`, lineNumber: i + 1, line: `hit ${i}` }))

  it('pages files with a next-offset footer, and says when the offset is past the end', () => {
    expect(formatGrepFiles(many, { offset: 0, limit: 2 })).toContain('f0.ts (2)\nf1.ts (2)\n\n(Showing files 1-2 of 3. Use offset=2 to see the next page, or narrow pattern, path, or include.)')
    expect(formatGrepFiles(many, { offset: 2, limit: 2 })).toMatch(/\n\nf2\.ts \(1\)\n\n\(Showing files 3 of 3\.\)$/u)
    expect(formatGrepFiles(many, { offset: 9, limit: 2 })).toMatch(/\n\n\(No files at offset 9\.\)$/u)
  })

  it('pages matches with a range header, and says when the offset is past the end', () => {
    const view = { context: [], window: { before: 0, after: 0 }, scopes: [], maxLineBytes: 100 }
    expect(formatGrepLines(many, { ...view, page: { offset: 2, limit: 2 } }))
      .toBe('Found 5 matches; showing 3-4\n\nf2.ts\nLine 3: hit 2\n\nf0.ts\nLine 4: hit 3\n\n(Showing matches 3-4 of 5. Use offset=4 to see the next page, or narrow pattern, path, or include.)')
    expect(formatGrepLines(many, { ...view, page: { offset: 4, limit: 2 } })).toBe('Found 5 matches; showing 5-5\n\nf1.ts\nLine 5: hit 4\n\n(Showing matches 5 of 5.)')
    expect(formatGrepLines(many, { ...view, page: { offset: 5, limit: 2 } })).toBe('No matches at offset 5: the search found 5 matches.')
    expect(formatGrepLines([], { ...view, page: { offset: 0, limit: 2 } })).toBe('No matches found')
  })

  it('pages a live call and spills only when matches remain past the page', async () => {
    const { subprocess, grep } = await setup()
    subprocess.stdout = many.map(m => record('match', m.path, m.lineNumber, m.line)).join('\n')
    expect(await grep({ pattern: 'hit', output: 'lines', head_limit: 2, offset: 3 })).toContain('(Showing matches 4-5 of 5.)')
    expect(await grep({ pattern: 'hit', head_limit: 1 })).toContain('(Showing files 1 of 3. Use offset=1')
    expect(await grep({ pattern: 'hit', head_limit: 1000 })).toContain('head_limit must be an integer from 1 to 250')
    expect(subprocess.spawns.at(-1)?.argv).toEqual(expect.arrayContaining(['--json']))
  })
})

describe('context lines', () => {
  it('shows nearby context marked with -, separates gaps with --, and drops context of other pages', async () => {
    const { subprocess, grep } = await setup({ grepAnnotateScopes: false })
    subprocess.stdout = [
      record('context', 'a.ts', 1, 'one'), record('match', 'a.ts', 2, 'two'), record('context', 'a.ts', 3, 'three'),
      record('context', 'a.ts', 9, 'nine'), record('match', 'a.ts', 10, 'ten'),
      record('context', 'a.ts', 49, 'far'), record('match', 'a.ts', 50, 'fifty'),
    ].join('\n')
    expect(await grep({ pattern: 't', output: 'lines', context: 1, head_limit: 2 })).toBe(
      'Found 2 of 3 matches\n\na.ts\nLine 1- one\nLine 2: two\nLine 3- three\n--\nLine 9- nine\nLine 10: ten\n\n'
      + '(Showing matches 1-2 of 3. Use offset=2 to see the next page, or narrow pattern, path, or include.)')
    expect(subprocess.spawns.at(-1)?.argv).toEqual(expect.arrayContaining(['--before-context=1', '--after-context=1']))
  })

  it('reaches only the requested side when one side is given', async () => {
    const { subprocess, grep } = await setup({ grepAnnotateScopes: false })
    subprocess.stdout = [record('context', 'a.ts', 1, 'one'), record('match', 'a.ts', 2, 'two'), record('context', 'a.ts', 3, 'three')].join('\n')
    expect(await grep({ pattern: 't', output: 'lines', after_context: 1 })).toBe('Found 1 match\n\na.ts\nLine 2: two\nLine 3- three')
    expect(await grep({ pattern: 't', output: 'lines', before_context: 1 })).toBe('Found 1 match\n\na.ts\nLine 1- one\nLine 2: two')
  })
})

describe('enclosing-declaration headers', () => {
  it('groups matches under the innermost declaration and marks lines outside any', async () => {
    const { subprocess, fs, grep } = await setup()
    fs?.files.set('/w/src/grep.ts', SOURCE)
    subprocess.stdout = [
      record('match', '/w/src/grep.ts', 5, '  return results.slice(0, limit)'),
      record('match', '/w/src/grep.ts', 10, '    this.items.push(limit)'),
      record('match', '/w/src/grep.ts', 13, 'const top = limit'),
      record('match', 'notes.md', 1, 'limit'),
    ].join('\n')
    expect(await grep({ pattern: 'limit', output: 'lines' })).toBe(`Found 4 matches

src/grep.ts
[L3 in executeGrep: export function executeGrep(opts: GrepOpts) {]
Line 5:   return results.slice(0, limit)
[L9 in Store.add: add(item: Thing): void {]
Line 10:     this.items.push(limit)
[L13 in top: const top = limit]
Line 13: const top = limit

notes.md
Line 1: limit`)
  })

  it('shows no headers without a filesystem, when turned off, for large or unreadable files, or outside every declaration', async () => {
    const lines = record('match', '/w/src/grep.ts', 5, 'x')
    const none = 'Found 1 match\n\nsrc/grep.ts\nLine 5: x'
    const noFs = await setup({}, false)
    noFs.subprocess.stdout = lines
    expect(await noFs.grep({ pattern: 'x', output: 'lines' })).toBe(none)
    const off = await setup({ grepAnnotateScopes: false })
    off.fs?.files.set('/w/src/grep.ts', SOURCE)
    off.subprocess.stdout = lines
    expect(await off.grep({ pattern: 'x', output: 'lines' })).toBe(none)
    const large = await setup({ grepScopeMaxFileBytes: 10 })
    large.fs?.files.set('/w/src/grep.ts', SOURCE)
    large.subprocess.stdout = lines
    expect(await large.grep({ pattern: 'x', output: 'lines' })).toBe(none)
    if (large.fs !== undefined) large.fs.size = -1
    expect(await large.grep({ pattern: 'x', output: 'lines' })).toBe(none)
    const broken = await setup()
    broken.fs?.files.set('/w/src/grep.ts', SOURCE)
    if (broken.fs !== undefined) broken.fs.failRead = true
    broken.subprocess.stdout = lines
    expect(await broken.grep({ pattern: 'x', output: 'lines' })).toBe(none)
    const outside = await setup()
    outside.fs?.files.set('/w/src/grep.ts', SOURCE)
    outside.subprocess.stdout = record('match', '/w/src/grep.ts', 1, 'import')
    expect(await outside.grep({ pattern: 'import', output: 'lines' })).toBe('Found 1 match\n\nsrc/grep.ts\nLine 1: import')
  })

  it('marks a return to top level after a declaration', async () => {
    const view = {
      page: { offset: 0, limit: 10 }, context: [], window: { before: 0, after: 0 }, maxLineBytes: 100,
      scopes: [{ path: 'a.ts', name: 'f', start: 2, end: 4, header: 'function f() {' }],
    }
    expect(formatGrepLines([{ path: 'a.ts', lineNumber: 3, line: 'in' }, { path: 'a.ts', lineNumber: 9, line: 'out' }], view))
      .toBe('Found 2 matches\n\na.ts\n[L2 in f: function f() {]\nLine 3: in\n[outside any declaration]\nLine 9: out')
  })
})

describe('config', () => {
  it('rejects non-positive grep limits and a negative context cap at load', async () => {
    await expect(setup({ grepDefaultHeadLimit: 0 })).rejects.toThrow('grepDefaultHeadLimit must be a positive integer')
    await expect(setup({ grepScopeMaxFileBytes: 0 })).rejects.toThrow('grepScopeMaxFileBytes must be a positive integer')
    await expect(setup({ grepMaxContextLines: -1 })).rejects.toThrow('grepMaxContextLines must be a non-negative integer')
    await expect(setup({ grepMaxContextLines: 1.5 })).rejects.toThrow('grepMaxContextLines must be a non-negative integer')
  })
})
