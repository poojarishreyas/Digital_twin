import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import Loader from '@elemental/cordis-plugin-loader'
import Include from '@elemental/cordis-plugin-include'
import { ToolCallId } from '@elemental/llm'
import { Session, SessionId } from '@elemental/session'
import SessionProjectionRegistry from '@elemental/session-projection'
import AgentRegistry, { Inbox } from '@elemental/agent'
import type { Agent } from '@elemental/agent'
import TerminalSessionService from '@elemental/terminal'
import * as TerminalBash from '@elemental/terminal-bash'
import SandboxProvider from '@elemental/sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@elemental/sandbox'
import SandboxPolicyService from '@elemental/sandbox-policy'
import LocalSubprocessService from '@elemental/subprocess-local'
import { resolvePwshPath } from '@elemental/pwsh-local/src/resolve.ts'
import SystemPrompt from '@elemental/system-prompt'
import ToolRegistry from '@elemental/tools'
import * as ToolPwshPersistent from '@elemental/tool-pwsh-persistent'

const hasPwsh = spawnSync(
  resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId('persistent-pwsh-loader-agent')
  const scope = ctx.plugin(() => { })
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => { }, discarded: () => { }, claimed: () => { } }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => { },
    followup: () => { },
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => { },
    cancel() { },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe.skipIf(!hasPwsh)('persistent pwsh through a real cordis.yml Loader composition', () => {
  it('preserves cwd and environment across calls', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'elemental-persistent-pwsh-loader-')))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@elemental/agent'",
      "- name: '@elemental/system-prompt'",
      "- name: '@elemental/tools'",
      "- name: '@elemental/terminal'",
      "- name: '@elemental/test-sandbox'",
      "- name: '@elemental/session-projection'",
      "- name: '@elemental/sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@elemental/subprocess-local'",
      "- name: '@elemental/terminal-bash'",
      '  config:',
      '    shellDialect: pwsh',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 300',
      '    handoffGraceMs: 300',
      '    scrollbackLines: 20000',
      '    timeoutMs: 60000',
      '    disposeGraceMs: 500',
      "- name: '@elemental/tool-pwsh-persistent'",
      '  config:',
      '    timeoutMs: 60000',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@elemental/agent', AgentRegistry],
      ['@elemental/system-prompt', SystemPrompt],
      ['@elemental/tools', ToolRegistry],
      ['@elemental/terminal', TerminalSessionService],
      ['@elemental/test-sandbox', PassthroughSandbox],
      ['@elemental/session-projection', SessionProjectionRegistry],
      ['@elemental/sandbox-policy', SandboxPolicyService],
      ['@elemental/subprocess-local', LocalSubprocessService],
      ['@elemental/terminal-bash', TerminalBash],
      ['@elemental/tool-pwsh-persistent', ToolPwshPersistent],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context, root)
    const signal = new AbortController().signal
    const execute = (id: string, command: string) => context!.tools.execute({
      signal,
      callId: ToolCallId(id),
      name: 'pwsh',
      arguments: { command },
      agent: owner,
    })

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['pwsh'])
    await execute('state', '$env:KEEP = "loader"; New-Item -ItemType Directory -Force -Path nested | Out-Null; Set-Location nested')
    const observed = text(await execute('observe', 'Write-Output "cwd=$PWD keep=$env:KEEP"'))
    expect(observed).toContain(`cwd=${join(root, 'nested')} keep=loader`)
    expect(observed).not.toContain('ELEMENTAL_PERSISTENT_PWSH')

    const multiline = text(await execute(
      'multiline',
      '$value = "line one"\nWrite-Output "${value}:it\'s fine"',
    ))
    expect(multiline).toBe("line one:it's fine")
    expect(multiline).not.toContain('ELEMENTAL_PERSISTENT_PWSH')

    const hereString = text(await execute(
      'here-string',
      "$h = @'\nalpha\nbeta\n'@\nWrite-Output $h",
    ))
    expect(hereString).toBe('alpha\nbeta')

    const large = text(await execute('large-output', '1..12050 | ForEach-Object { $_ }'))
    expect(large.startsWith('1\n2\n3\n')).toBe(true)
    expect(large).toContain('<response clipped>')
    expect(large).not.toContain('beginning of this command output was dropped')

    const exited = text(await execute('exit', 'exit'))
    expect(exited).toContain('next pwsh call starts from the workspace')
    expect(text(await execute('after-exit', 'Write-Output "$PWD"'))).toBe(root)
  }, 120_000)
})
