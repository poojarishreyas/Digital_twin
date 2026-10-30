/**
 * Tests for the edit-check PLUGIN, driven through a real tool registry and the local subprocess
 * runtime. The checker is a small Node script that reports every line containing `BAD`, so each
 * case controls exactly which diagnostics exist before and after a change.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@elemental/cordis'
import type { ContentBlock } from '@elemental/llm'
import { ToolCallId } from '@elemental/llm'
import LocalSubprocessRuntime from '@elemental/subprocess-local'
import SystemPrompt from '@elemental/system-prompt'
import ToolRuntime, { defineContentToolFixture, defineTool } from '@elemental/tools'
import type { PostToolDecision, ToolExecution } from '@elemental/tools'
import * as EditCheck from '@elemental/edit-check'

const workdir = mkdtempSync(join(tmpdir(), 'edit-check-'))
afterAll(() => rmSync(workdir, { recursive: true, force: true }))

/** Prints `<file>:<n>:1: E1 bad token` for each line containing BAD, from stdin or the file argument. */
const CHECKER = `
const fs = require('node:fs')
const file = process.argv[1]
const text = process.argv[2] === 'disk' ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')
text.split('\\n').forEach((line, i) => { if (line.includes('BAD')) console.log(file + ':' + (i + 1) + ':1: E1 bad token') })
console.log('other.py:1:1: E9 not this file')
`

const stdinChecker: EditCheck.CheckerSpec = { extensions: ['.py'], command: process.execPath, args: ['-e', CHECKER, '{path}'], stdin: true }
const diskChecker: EditCheck.CheckerSpec = { extensions: ['.PY'], command: process.execPath, args: ['-e', CHECKER, '{path}', 'disk'] }

interface Change { path: string; before: string | null; after: string }

/** A tool returning a scripted `{ path, before, after }` value, rendered as one confirmation line. */
function changeTool(name: string, next: () => Change) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Updated ${value.path}.` }],
    },
    execute: () => Promise.resolve(next()),
  })
}

async function setup(config: EditCheck.Config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(EditCheck, config)
  let change: Change = { path: 'a.py', before: '', after: '' }
  ctx.tools.register(changeTool('edit', () => change))
  ctx.tools.register(changeTool('write', () => change))
  ctx.tools.register(changeTool('move', () => change))
  const run = async (name: string, next: Change, extra: Record<string, unknown> = {}) => {
    change = next
    return ctx.tools.execute({
      callId: ToolCallId(`call-${name}`),
      name,
      arguments: {},
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: workdir } } } as never,
      ...extra,
    } as unknown as ToolExecution)
  }
  return { ctx, fiber, run }
}

function text(content: ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('|')
}

const lines = (...body: string[]): string => `${body.join('\n')}\n`

describe('stdin checkers', () => {
  it('reports only the diagnostics a change introduced, numbered by current lines', async () => {
    const { run } = await setup({ checkers: { lint: stdinChecker } })
    const result = await run('edit', { path: 'a.py', before: lines('ok', 'BAD one'), after: lines('ok', 'BAD one', 'BAD two') })
    expect(text(result.content)).toBe('Updated a.py.\n[Shadow check (lint): this change introduced 1 diagnostic. L3: E1 bad token.]')
  })

  it('treats a new file as having no earlier diagnostics', async () => {
    const { run } = await setup({ checkers: { lint: stdinChecker } })
    const result = await run('write', { path: join(workdir, 'new.py'), before: null, after: lines('BAD') })
    expect(text(result.content)).toContain('this change introduced 1 diagnostic. L1: E1 bad token.')
  })

  it('leaves the result alone when nothing new appears', async () => {
    const { run } = await setup({ checkers: { lint: stdinChecker } })
    const result = await run('edit', { path: 'a.py', before: lines('BAD', 'x'), after: lines('x', 'BAD') })
    expect(text(result.content)).toBe('Updated a.py.')
  })
})

describe('on-disk checkers', () => {
  it('reports every diagnostic the first time, then only new ones against the previous check', async () => {
    const { run } = await setup({ checkers: { lint: diskChecker }, maxListed: 1 })
    const path = join(workdir, 'disk.py')
    writeFileSync(path, lines('BAD a', 'BAD b'))
    const first = await run('edit', { path, before: 'old', after: '' })
    expect(text(first.content)).toContain('[Shadow check (lint): the file has 2 diagnostics after this change. L1: E1 bad token; and 1 more.]')
    writeFileSync(path, lines('BAD a', 'BAD b', 'BAD c'))
    const second = await run('edit', { path, before: 'old', after: '' })
    expect(text(second.content)).toContain('this change introduced 1 diagnostic. L3: E1 bad token.')
    const created = join(workdir, 'created.py')
    writeFileSync(created, lines('BAD'))
    expect(text((await run('write', { path: created, before: null, after: '' })).content)).toContain('this change introduced 1 diagnostic.')
    writeFileSync(created, lines('fine'))
    expect(text((await run('edit', { path: created, before: 'old', after: '' })).content)).toBe(`Updated ${created}.`)
  })

  it('runs in the process directory when the call has no session working directory', async () => {
    const { run } = await setup({ checkers: { lint: stdinChecker } })
    const absolute = join(workdir, 'nocwd.py')
    const noAgent = await run('edit', { path: absolute, before: null, after: 'BAD' }, { agent: undefined })
    expect(text(noAgent.content)).toContain('this change introduced 1 diagnostic.')
    const noCwd = await run('edit', { path: absolute, before: null, after: 'BAD' }, { agent: { session: { header: {} } } as never })
    expect(text(noCwd.content)).toContain('this change introduced 1 diagnostic.')
  })
})

describe('best-effort limits', () => {
  it('reports nothing when the checker misses its deadline', async () => {
    const slow: EditCheck.CheckerSpec = { extensions: ['.py'], command: process.execPath, args: ['-e', 'setTimeout(() => console.log("a.py:1:1: E1 late"), 5000)'], stdin: false }
    const { run } = await setup({ checkers: { slow }, timeoutMs: 100, graceMs: 50 })
    const started = Date.now()
    const result = await run('edit', { path: 'a.py', before: null, after: '' })
    expect(text(result.content)).toBe('Updated a.py.')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('disables a checker whose executable cannot be found, warning once', async () => {
    const { ctx, run } = await setup({ checkers: { gone: { extensions: ['.py'], command: 'definitely-not-a-checker-xyz', args: [] } } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { })
    for (let i = 0; i < 2; i += 1) expect(text((await run('edit', { path: 'a.py', before: null, after: '' })).content)).toBe('Updated a.py.')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reports nothing when the checker cannot start, for either side of the comparison', async () => {
    const broken: EditCheck.CheckerSpec = { extensions: ['.py'], command: process.execPath, args: ['bad\0arg'], stdin: true }
    const { run } = await setup({ checkers: { broken } })
    expect(text((await run('edit', { path: 'a.py', before: 'x', after: 'BAD' })).content)).toBe('Updated a.py.')
    expect(text((await run('write', { path: 'a.py', before: null, after: 'BAD' })).content)).toBe('Updated a.py.')
  })

  it('reports nothing when the checker is killed by a signal', async () => {
    const killed: EditCheck.CheckerSpec = { extensions: ['.py'], command: process.execPath, args: ['-e', 'console.log("a.py:1:1: E1 x"); process.kill(process.pid, "SIGKILL")'] }
    const { run } = await setup({ checkers: { killed } })
    expect(text((await run('write', { path: 'a.py', before: null, after: '' })).content)).toBe('Updated a.py.')
  })
})

describe('which results are checked', () => {
  it('skips unchecked tools and extensions, nested calls, and values without a changed file', async () => {
    const { run } = await setup({ checkers: { lint: stdinChecker } })
    const bad = { path: 'a.py', before: null, after: 'BAD' }
    expect(text((await run('move', bad)).content)).toBe('Updated a.py.')
    expect(text((await run('edit', { ...bad, path: 'a.ts' })).content)).toBe('Updated a.ts.')
    expect(text((await run('edit', bad, { parent: { callId: ToolCallId('outer') } as never })).content)).toBe('Updated a.py.')
    // A checked tool whose value is not a changed file.
    const { ctx: other, run: runOther } = await setup({ checkers: { lint: stdinChecker }, tools: ['plain'] })
    other.tools.register(defineContentToolFixture({
      name: 'plain', description: 'plain', parameters: {},
      async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text: 'done' }] },
    }))
    expect(text((await runOther('plain', bad)).content)).toBe('done')
  })

  it('reads only string paths and texts from a checked tool\'s value, treating a missing before as a new file', async () => {
    const { ctx, run } = await setup({ checkers: { lint: stdinChecker }, tools: ['str', 'noafter', 'nobefore'] })
    ctx.tools.register(defineTool({
      name: 'str', description: 'str', parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.resolve('a.py'),
    }))
    ctx.tools.register(defineTool({
      name: 'noafter', description: 'noafter', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
        render: (_a, v) => [{ type: 'text', text: v.path }],
      },
      execute: () => Promise.resolve({ path: 'a.py' }),
    }))
    ctx.tools.register(defineTool({
      name: 'nobefore', description: 'nobefore', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, after: { type: 'string', required: true } } },
        render: (_a, v) => [{ type: 'text', text: v.path }],
      },
      execute: () => Promise.resolve({ path: 'a.py', after: 'BAD' }),
    }))
    const any = { path: 'a.py', before: null, after: '' }
    expect(text((await run('str', any)).content)).toBe('a.py')
    expect(text((await run('noafter', any)).content)).toBe('a.py')
    expect(text((await run('nobefore', any)).content)).toBe('a.py\n[Shadow check (lint): this change introduced 1 diagnostic. L1: E1 bad token.]')
  })

  it('passes failed results, blocks, and value replacements through, and keeps added contexts', async () => {
    const { ctx, run } = await setup({ checkers: { lint: stdinChecker } })
    const bad = { path: 'a.py', before: null, after: 'BAD' }
    let decision: PostToolDecision | undefined
    ctx.on('tools/post-execute', async (_exec, _result, next) => decision ?? next())
    decision = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    expect(text((await run('edit', bad)).content)).toBe('blocked')
    decision = { kind: 'accept', value: { path: 'a.py', before: null, after: 'replaced' } }
    expect(text((await run('edit', bad)).content)).toBe('Updated a.py.')
    const context = { role: 'user' as const, content: [{ type: 'text' as const, text: 'note' }], source: { kind: 'system' as const } }
    decision = { kind: 'accept', content: [{ type: 'text', text: 'hooked' }, { type: 'reasoning', text: 'r' }], additionalContexts: [context as never] }
    const hooked = await run('edit', bad)
    expect(text(hooked.content)).toBe('hooked|<reasoning>|[Shadow check (lint): this change introduced 1 diagnostic. L1: E1 bad token.]')
    expect(hooked.additionalContexts).toHaveLength(1)
    const { run: runFailing, ctx: failingCtx } = await setup({ checkers: { lint: stdinChecker }, tools: ['failing'] })
    failingCtx.tools.register(defineTool({
      name: 'failing', description: 'failing', parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.reject(new Error('nope')),
    }))
    expect((await runFailing('failing', bad)).isError).toBe(true)
  })
})

describe('configuration', () => {
  it('registers nothing without checkers, including when applied without schema defaults', async () => {
    const { run } = await setup({})
    expect(text((await run('edit', { path: 'a.py', before: null, after: 'BAD' })).content)).toBe('Updated a.py.')
    expect(() => EditCheck.apply(new Context(), {})).not.toThrow()
  })

  it('rejects empty, undotted, or doubly claimed extensions and non-positive limits at load', async () => {
    await expect(setup({ checkers: { a: { ...stdinChecker, extensions: [] } } }))
      .rejects.toThrow(/checkers\.a\.extensions must list at least one extension/)
    await expect(setup({ checkers: { a: { ...stdinChecker, extensions: ['py'] } } })).rejects.toThrow(/must start with a dot \(got "py"\)/)
    await expect(setup({ checkers: { a: stdinChecker, b: diskChecker } })).rejects.toThrow(/\.PY is claimed by both a and b/)
    for (const field of ['timeoutMs', 'maxListed', 'maxOutputBytes'] as const) {
      await expect(setup({ checkers: { a: stdinChecker }, [field]: 0 })).rejects.toThrow(new RegExp(`${field} must be a positive integer`))
    }
  })

  it('stops checking after the plugin is disposed', async () => {
    const { fiber, run } = await setup({ checkers: { lint: stdinChecker } })
    await fiber.dispose()
    expect(text((await run('edit', { path: 'a.py', before: null, after: 'BAD' })).content)).toBe('Updated a.py.')
  })
})
