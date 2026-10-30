/**
 * Registry tests for `@elemental/shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@elemental/cordis'
import { ToolCallId } from '@elemental/llm'
import type { Agent } from '@elemental/agent'
import type { ToolExecution } from '@elemental/tools'
import { ShellEnvRegistry } from '@elemental/shell-env'
import * as BashEnvPlugin from '@elemental/shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: ToolCallId('bash-env-call'),
    rootCallId: ToolCallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : { agent: { session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as Agent }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { elementalHome: './test-elemental-home' })

    expect(registry.collect(execution())).toEqual({
      ELEMENTAL_HOME: resolve('./test-elemental-home'),
      ELEMENTAL_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      ELEMENTAL_HOME: resolve('./test-elemental-home'),
      ELEMENTAL_SESSION_ID: 'session-a',
      ELEMENTAL_SHELL: '1',
    })
  })

  it('resolves ELEMENTAL_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('ELEMENTAL_HOME', './ambient-elemental-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).ELEMENTAL_HOME).toBe(resolve('./ambient-elemental-home'))

    vi.stubEnv('ELEMENTAL_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).ELEMENTAL_HOME).toBe(join(homedir(), '.elemental'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { elementalHome: './test-elemental-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        ELEMENTAL_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { ELEMENTAL_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        ELEMENTAL_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ ELEMENTAL_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('ELEMENTAL_SESSION_OPTIONAL')
    expect(registry.collect(execution()).ELEMENTAL_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).ELEMENTAL_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'ELEMENTAL_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'ELEMENTAL_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { elementalHome: './test-elemental-home' })
    registry.register({
      name: 'first',
      variables: { ELEMENTAL_SHARED: { description: 'First owner.' } },
      resolve: () => ({ ELEMENTAL_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { ELEMENTAL_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ ELEMENTAL_SHARED: 'second' }),
    })).toThrow(/ELEMENTAL_SHARED.*first.*second|ELEMENTAL_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { elementalHome: './test-elemental-home' })
    registry.register({
      name: 'declared',
      variables: { ELEMENTAL_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { ELEMENTAL_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { ELEMENTAL_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { elemental_invalid: { description: 'Invalid key.' } } as unknown as Record<'ELEMENTAL_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { ELEMENTAL_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { ELEMENTAL_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { elementalHome: './test-elemental-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { ELEMENTAL_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ ELEMENTAL_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*ELEMENTAL_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { elementalHome: './test-elemental-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { ELEMENTAL_STRING: { description: 'String fact.' } },
      resolve: () => ({ ELEMENTAL_STRING: 42 }) as unknown as Record<'ELEMENTAL_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*ELEMENTAL_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { elementalHome: './test-elemental-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { ELEMENTAL_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ ELEMENTAL_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).ELEMENTAL_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('ELEMENTAL_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { elementalHome: './test-elemental-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { ELEMENTAL_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ ELEMENTAL_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).ELEMENTAL_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('ELEMENTAL_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service and the persistence contributor on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([
      {
        contributor: 'session-persistence',
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
        key: 'ELEMENTAL_SESSION_JSONL',
      },
    ])
  })

  it('the persistence contributor resolves ELEMENTAL_SESSION_JSONL only for a jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p')).ELEMENTAL_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
  })

  it('the persistence contributor omits the variable for a non-jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'sqlite' as const, path: 'C:\\sessions\\s.db' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('ELEMENTAL_SESSION_JSONL')
  })

  it('the persistence contributor omits the variable without a persistence backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('ELEMENTAL_SESSION_JSONL')
  })
})
