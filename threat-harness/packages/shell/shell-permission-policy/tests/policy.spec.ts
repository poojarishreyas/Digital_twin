/**
 * How the shell permission policy decides where a call runs and when it asks.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@elemental/cordis'
import type { Agent } from '@elemental/agent'
import { ToolCallId } from '@elemental/llm'
import type { SandboxExecutionPolicy, SandboxMode } from '@elemental/sandbox'
import { SessionId } from '@elemental/session'
import { SettingsProvider } from '@elemental/settings'
import type { SettingsNamespace } from '@elemental/settings'
import type { ToolExecution } from '@elemental/tools'
import type { ApprovalOutcome, ApprovalPolicy } from '@elemental/user-approval'
import ShellPermissionPolicy, { SHELL_PERMISSION_SETTINGS_NAMESPACE } from '@elemental/shell-permission-policy'
import type { Config, ShellCommandCheck } from '@elemental/shell-permission-policy'

/** Writable memory settings provider. */
class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const ROOT = 'C:\\work\\repo'

interface Setup {
  ctx: Context
  request: ReturnType<typeof vi.fn>
}

async function setup(options: {
  config?: Config
  outcome?: ApprovalOutcome
  policy?: ApprovalPolicy
  settings?: boolean
} = {}): Promise<Setup> {
  const ctx = new Context()
  if (options.settings !== false) await ctx.plugin(MemorySettings)
  const request = vi.fn(() => Promise.resolve<ApprovalOutcome>(options.outcome ?? 'allowed-once'))
  ctx.provide('approval', { effectivePolicy: () => options.policy ?? 'ask', request })
  await ctx.plugin(ShellPermissionPolicy, options.config ?? {})
  return { ctx, request }
}

function agent(delegated = false, cwd: string | undefined = ROOT): Agent {
  const id = SessionId('s1')
  const events = delegated ? [{ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }] : []
  return { id, session: { id, header: { version: 0, id, createdAt: 0, ...cwd === undefined ? {} : { cwd } }, events } } as unknown as Agent
}

function check(command: string, overrides: {
  mode?: SandboxMode | undefined
  agent?: Agent | undefined
  escalating?: boolean
  dialect?: 'bash' | 'pwsh'
  root?: string | undefined
} = {}): ShellCommandCheck {
  const mode = 'mode' in overrides ? overrides.mode : 'workspace-write'
  const standing: SandboxExecutionPolicy | undefined = mode === undefined
    ? undefined
    : { mode, workspaceRoot: 'root' in overrides ? overrides.root as string : ROOT }
  const exec = {
    callId: ToolCallId('call-1'),
    name: 'bash',
    arguments: { command },
    signal: new AbortController().signal,
    ...'agent' in overrides ? overrides.agent === undefined ? {} : { agent: overrides.agent } : { agent: agent() },
  } as unknown as ToolExecution
  return { command, dialect: overrides.dialect ?? 'bash', exec, standing, escalating: overrides.escalating ?? false }
}

describe('ShellPermissionPolicy with the sandbox off (the default)', () => {
  it('runs read-only and allowed commands outside the sandbox without asking', async () => {
    const { ctx, request } = await setup({ config: { allow: ['bash(pnpm vitest *)'] } })
    await expect(ctx.shellPermissionPolicy.authorize(check('git status && cat a.ts')))
      .resolves.toEqual({ mode: 'danger-full-access', workspaceRoot: ROOT })
    await expect(ctx.shellPermissionPolicy.authorize(check('pnpm vitest run a.spec.ts')))
      .resolves.toMatchObject({ mode: 'danger-full-access' })
    expect(request).not.toHaveBeenCalled()
  })

  it('asks about other commands, offering prefix rules, and runs them outside the sandbox when allowed', async () => {
    const { ctx, request } = await setup()
    await expect(ctx.shellPermissionPolicy.authorize(check('npm run build && npm run lint'))).resolves.toMatchObject({ mode: 'danger-full-access' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'bash',
      callId: 'call-1',
      reason: 'Run this command? (no permission rule allows this command)',
      suggestedRules: ['bash(npm run *)'],
    }))
  })

  it('saves the offered rules for the workspace on "don\'t ask again" and stops asking', async () => {
    const { ctx, request } = await setup({ outcome: 'allowed-always' })
    await ctx.shellPermissionPolicy.authorize(check('pnpm vitest run a.spec.ts'))
    expect(ctx.settings.get(SHELL_PERMISSION_SETTINGS_NAMESPACE)).toMatchObject({
      workspaces: { 'C:/work/repo': { allow: ['bash(pnpm vitest *)'] } },
    })
    await ctx.shellPermissionPolicy.authorize(check('pnpm vitest run b.spec.ts'))
    expect(request).toHaveBeenCalledTimes(1)
    // A second grant adds only rules not already saved.
    await ctx.shellPermissionPolicy.authorize(check('pnpm vitest run && npm run lint'))
    expect(ctx.settings.get(SHELL_PERMISSION_SETTINGS_NAMESPACE)).toMatchObject({
      workspaces: { 'C:/work/repo': { allow: ['bash(pnpm vitest *)', 'bash(npm run *)'] } },
    })
  })

  it('grants once when no settings provider can save the rule', async () => {
    const { ctx, request } = await setup({ outcome: 'allowed-always', settings: false })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test'))).resolves.toMatchObject({ mode: 'danger-full-access' })
    await ctx.shellPermissionPolicy.authorize(check('npm test'))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('offers no rule when the call has no workspace root', async () => {
    const { ctx, request } = await setup()
    await ctx.shellPermissionPolicy.authorize(check('npm test', { root: '', agent: agent(false, undefined) }))
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty('suggestedRules')
  })

  it.each([
    ['rejected', 'The user declined to run this command'],
    ['cancelled', 'was cancelled'],
    ['unavailable', 'no one can approve it now'],
  ] as const)('refuses the command when the answer is %s', async (outcome, message) => {
    const { ctx } = await setup({ outcome })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test'))).rejects.toThrow(message)
  })

  it('fails loud on an approval answer outside the vocabulary', async () => {
    const { ctx } = await setup({ outcome: 'maybe' as ApprovalOutcome })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test'))).rejects.toThrow('ApprovalOutcome')
  })

  it('grants an always-answer once when the call has no workspace to save rules for', async () => {
    const { ctx, request } = await setup({ outcome: 'allowed-always' })
    await ctx.shellPermissionPolicy.authorize(check('npm test', { root: '', agent: agent(false, undefined) }))
    expect(ctx.settings.get(SHELL_PERMISSION_SETTINGS_NAMESPACE)).toMatchObject({ workspaces: {} })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('refuses a command that needs asking when the call has no agent', async () => {
    const { ctx } = await setup()
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { agent: undefined }))).rejects.toThrow('no agent to ask through')
  })

  it('denies a command a deny rule names, even when it escalates or is wrapped', async () => {
    const { ctx, request } = await setup({ config: { deny: ['bash(rm -rf *)'] } })
    await expect(ctx.shellPermissionPolicy.authorize(check('timeout 5 rm -rf dist'))).rejects.toThrow('Permission denied: denied by rule bash(rm -rf *)')
    await expect(ctx.shellPermissionPolicy.authorize(check('rm -rf dist', { escalating: true }))).rejects.toThrow('Permission denied')
    expect(request).not.toHaveBeenCalled()
  })

  it('leaves an escalating call to the escalation prompt', async () => {
    const { ctx, request } = await setup()
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { escalating: true })))
      .resolves.toEqual({ mode: 'workspace-write', workspaceRoot: ROOT })
    expect(request).not.toHaveBeenCalled()
  })

  it('applies rules per shell', async () => {
    const { ctx, request } = await setup({ config: { allow: ['pwsh(npm test *)'] } })
    await ctx.shellPermissionPolicy.authorize(check('npm test', { dialect: 'pwsh' }))
    expect(request).not.toHaveBeenCalled()
    await ctx.shellPermissionPolicy.authorize(check('npm test'))
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks and runs unconfined when the executor does not confine', async () => {
    const { ctx, request } = await setup()
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { mode: undefined }))).resolves.toBeUndefined()
    await expect(ctx.shellPermissionPolicy.authorize(check('git status', { mode: undefined }))).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('ShellPermissionPolicy with the sandbox on', () => {
  const sandboxed = { sandbox: { enabled: true, excludedCommands: ['pnpm vitest *'] }, ask: ['bash(git push *)'] }

  it('runs commands confined without asking, except ask rules', async () => {
    const { ctx, request } = await setup({ config: sandboxed })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm run build'))).resolves.toEqual({ mode: 'workspace-write', workspaceRoot: ROOT })
    expect(request).not.toHaveBeenCalled()
    await expect(ctx.shellPermissionPolicy.authorize(check('git push origin main'))).resolves.toMatchObject({ mode: 'workspace-write' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Run this command? (rule bash(git push *) always asks)' }))
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty('suggestedRules')
  })

  it('runs excluded commands outside the sandbox through the permission flow', async () => {
    const { ctx, request } = await setup({ config: sandboxed })
    await expect(ctx.shellPermissionPolicy.authorize(check('pnpm vitest run'))).resolves.toMatchObject({ mode: 'danger-full-access' })
    expect(request).toHaveBeenCalledTimes(1)
    await expect(ctx.shellPermissionPolicy.authorize(check('pnpm vitest run && npm run build'))).resolves.toMatchObject({ mode: 'workspace-write' })
  })

  it('keeps read-only sessions confined and leaves full-access sessions unconfined', async () => {
    const { ctx, request } = await setup({ config: { sandbox: { enabled: false, excludedCommands: [] } } })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { mode: 'read-only' }))).resolves.toMatchObject({ mode: 'read-only' })
    expect(request).not.toHaveBeenCalled()
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { mode: 'danger-full-access' }))).resolves.toMatchObject({ mode: 'danger-full-access' })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('ShellPermissionPolicy when no one is asked', () => {
  it('runs everything unconfined when the user chose no prompts', async () => {
    const { ctx, request } = await setup({ policy: 'never' })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test'))).resolves.toMatchObject({ mode: 'danger-full-access' })
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a delegated child\'s standing policy instead of asking', async () => {
    const { ctx, request } = await setup({ policy: 'never' })
    const child = agent(true)
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { agent: child }))).resolves.toEqual({ mode: 'workspace-write', workspaceRoot: ROOT })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { agent: child, mode: 'danger-full-access' }))).resolves.toMatchObject({ mode: 'danger-full-access' })
    expect(request).not.toHaveBeenCalled()
  })

  it('cannot confine a delegated child without a confining executor, so it asks', async () => {
    const { ctx, request } = await setup({ policy: 'never', outcome: 'rejected' })
    await expect(ctx.shellPermissionPolicy.authorize(check('npm test', { agent: agent(true), mode: undefined }))).rejects.toThrow('declined')
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('ShellPermissionPolicy settings', () => {
  it('rejects a malformed rule in the composition config', async () => {
    await expect(setup({ config: { allow: ['git status'] } })).rejects.toThrow('invalid shell permission rule')
  })

  it('rejects a malformed rule written to settings and reads valid edits on the next call', async () => {
    const { ctx, request } = await setup()
    await expect(ctx.settings.update(SHELL_PERMISSION_SETTINGS_NAMESPACE, { deny: ['rm'] })).rejects.toThrow('invalid shell permission rule')
    await expect(ctx.settings.update(SHELL_PERMISSION_SETTINGS_NAMESPACE, { workspaces: { x: { allow: ['nope'] } } })).rejects.toThrow('invalid shell permission rule')
    await ctx.settings.update(SHELL_PERMISSION_SETTINGS_NAMESPACE, { allow: ['bash(npm test)'] })
    await ctx.shellPermissionPolicy.authorize(check('npm test'))
    expect(request).not.toHaveBeenCalled()
  })
})
