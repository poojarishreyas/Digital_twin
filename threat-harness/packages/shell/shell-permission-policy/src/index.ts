/**
 * Permission policy for model-run shell commands: decides, before a `bash` or `pwsh` call runs,
 * whether it runs inside the OS sandbox, runs outside it, asks the user first, or is refused.
 *
 * Commands run outside the sandbox unless `sandbox.enabled` is set (then a `workspace-write`
 * session confines them, except `sandbox.excludedCommands`). A command outside the sandbox runs
 * when allow rules or the read-only list cover every part of it; otherwise the user is asked,
 * and "don't ask again" saves the offered allow rules for the workspace. A confined command runs
 * without asking. Deny rules refuse a command anywhere, ask rules make it ask anywhere. When no
 * one can be asked because the session is a delegated child, an uncovered command runs confined
 * instead.
 *
 * @module @elemental/shell-permission-policy
 */

import { Service } from '@elemental/cordis'
import type { Context } from '@elemental/cordis'
import z from '@elemental/schemastery'
import type { Agent } from '@elemental/agent'
import type { SandboxExecutionPolicy } from '@elemental/sandbox'
import type { ShellDialect } from '@elemental/shell'
import type { ToolExecution } from '@elemental/tools'
import { assertNever } from '@elemental/util-values'
import type { } from '@elemental/settings'
import type { } from '@elemental/user-approval'
import { evaluate, matchesExcluded, parseRule, patternMatcher } from './rules.ts'
import type { ShellRule } from './rules.ts'
import type { PermissionRules, RuleEvaluation, ShellPermissionSettings } from './types.ts'

export { evaluate, matchesExcluded, parseRule, patternMatcher } from './rules.ts'
export type { ShellRule } from './rules.ts'
export { isReadOnlyCommand } from './allowlist.ts'
export { suggestRule } from './suggest.ts'
export { allowWords, guardWords } from './words.ts'
export type * from './types.ts'

/** Settings namespace holding the rules and sandbox switches. */
export const SHELL_PERMISSION_SETTINGS_NAMESPACE = 'shell-permissions'

declare module '@elemental/cordis' {
  interface Context {
    shellPermissionPolicy: ShellPermissionPolicy
  }
}

/** One shell call to authorize. */
export interface ShellCommandCheck {
  /** The command text as the model wrote it. */
  readonly command: string
  /** The shell it runs in. */
  readonly dialect: ShellDialect
  /** The tool call. */
  readonly exec: ToolExecution
  /** The call's standing sandbox policy, or `undefined` when the executor does not confine. */
  readonly standing: SandboxExecutionPolicy | undefined
  /** Whether the call carries a `sandbox_permissions` escalation, which asks through its own path. */
  readonly escalating: boolean
}

/** The {@link ShellPermissionPolicy} config: the composition's base settings; omitted fields default to empty or off. */
export interface Config {
  /** Whether and where commands run inside the OS sandbox. */
  sandbox?: Partial<ShellPermissionSettings['sandbox']>
  /** Rules that let a command run without asking. */
  allow?: string[]
  /** Rules that make a command ask every time. */
  ask?: string[]
  /** Rules that refuse a command. */
  deny?: string[]
}

const ruleList = (): z<string[]> => z.array(z.string()).default([])

/**
 * Decides how each model-run shell command may run. Reads its rules from the
 * `shell-permissions` settings section on every call, so edits apply to the next command.
 */
export class ShellPermissionPolicy extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    sandbox: z.object({
      enabled: z.boolean().default(false).description('Run commands in the OS sandbox when the session mode is workspace-write.'),
      excludedCommands: ruleList().description('Command patterns that run outside the sandbox even when it is enabled.'),
    }).default({ enabled: false, excludedCommands: [] }),
    allow: ruleList().description('Rules such as bash(npm run *) that let a command run without asking.'),
    ask: ruleList().description('Rules that make a command ask every time.'),
    deny: ruleList().description('Rules that refuse a command.'),
  })

  static inject = ['approval']

  private settings: () => ShellPermissionSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'shellPermissionPolicy')
    // The schema defaulted every field — the cast records that runtime fact.
    const base: ShellPermissionSettings = { ...config as Omit<ShellPermissionSettings, 'workspaces'>, workspaces: {} }
    validate(base)
    this.settings = () => base
    const schema: z<ShellPermissionSettings> = z.object({
      sandbox: z.object({
        enabled: z.boolean().required(),
        excludedCommands: ruleList(),
      }).required(),
      allow: ruleList(),
      ask: ruleList(),
      deny: ruleList(),
      workspaces: z.dict(z.object({ allow: ruleList() })).default({}),
    })
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SHELL_PERMISSION_SETTINGS_NAMESPACE, schema, base, {
        setSource: (current) => { this.settings = current },
        // Rules are read on every call; nothing is cached.
        onChange: () => { },
        validate,
      })
    })
  }

  /**
   * Authorize one shell call before it runs, asking the user when needed.
   * @param check - the call and its standing sandbox policy.
   * @returns the sandbox policy the call runs under: the standing policy, or one stamped
   *   `danger-full-access` when the command runs outside the sandbox; `undefined` when the
   *   executor does not confine.
   * @throws {Error} when a rule refuses the command, the user declines, or no one can approve it.
   */
  async authorize(check: ShellCommandCheck): Promise<SandboxExecutionPolicy | undefined> {
    const settings = this.settings()
    const { standing, exec } = check
    const root = workspaceKey(standing?.workspaceRoot ?? exec.agent?.session.header.cwd)
    const verdict = evaluate(check.command, check.dialect, rulesFor(settings, check.dialect, root))
    if (verdict.behavior === 'deny') throw new Error(`Permission denied: ${verdict.reason}. Do not retry this command another way.`)
    // An escalation asks through the sandbox's own approval; this policy only applies deny rules to it.
    if (check.escalating) return standing
    const unconfined = (policy: SandboxExecutionPolicy | undefined): SandboxExecutionPolicy | undefined =>
      policy === undefined ? undefined : { ...policy, mode: 'danger-full-access' }
    if (standing !== undefined && runsConfined(settings, check, standing)) {
      // A confined command runs without asking unless an ask rule names it.
      if (verdict.behavior === 'ask' && verdict.byRule) await this.ask(check, verdict, root)
      return standing
    }
    if (verdict.behavior === 'allow') return unconfined(standing)
    const agent = exec.agent
    if (agent !== undefined && this.ctx.approval.effectivePolicy(agent.session) === 'never') {
      // A session whose user chose `never` has opted out of prompts. A delegated child cannot ask
      // anyone, so it keeps its standing policy: confined under workspace-write, unconfined when
      // its parent chose full access.
      if (!delegated(agent)) return unconfined(standing)
      if (standing !== undefined) return standing
    }
    await this.ask(check, verdict, root)
    return unconfined(standing)
  }

  /** Ask the user about one call; returns on a grant and throws otherwise. */
  private async ask(check: ShellCommandCheck, verdict: RuleEvaluation & { behavior: 'ask' }, root: string | undefined): Promise<void> {
    const agent = check.exec.agent
    if (agent === undefined) throw new Error(`This command needs the user's permission (${verdict.reason}), but the call has no agent to ask through.`)
    const offer = root === undefined ? [] : verdict.suggestions
    const outcome = await this.ctx.approval.request({
      agent,
      toolName: check.exec.name,
      callId: check.exec.callId,
      reason: `Run this command? (${verdict.reason})`,
      ...offer.length > 0 ? { suggestedRules: offer } : {},
      signal: check.exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return
      case 'allowed-always':
        if (root !== undefined) await this.remember(root, offer)
        return
      case 'rejected': throw new Error('The user declined to run this command. Do not retry it another way; ask the user how to proceed.')
      case 'cancelled': throw new Error('The permission request for this command was cancelled.')
      case 'unavailable': throw new Error(`This command needs the user's permission (${verdict.reason}), but no one can approve it now.`)
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /** Save allow rules for one workspace. */
  private async remember(root: string, rules: readonly string[]): Promise<void> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    const existing = this.settings().workspaces[root]?.allow ?? []
    const allow = [...existing, ...rules.filter(rule => !existing.includes(rule))]
    await settings.mutate(SHELL_PERMISSION_SETTINGS_NAMESPACE, [{ op: 'set', path: ['workspaces', root, 'allow'], value: allow }])
  }
}

/** Whether the call runs inside the OS sandbox under the standing policy. */
function runsConfined(settings: ShellPermissionSettings, check: ShellCommandCheck, standing: SandboxExecutionPolicy): boolean {
  if (standing.mode === 'danger-full-access') return false
  if (standing.mode === 'read-only') return true
  if (!settings.sandbox.enabled) return false
  const excluded = settings.sandbox.excludedCommands.map(pattern => patternMatcher(pattern, check.dialect))
  return !matchesExcluded(check.command, check.dialect, excluded)
}

/** Whether the session's `never` approval policy was pinned by delegation rather than chosen. */
function delegated(agent: Agent): boolean {
  const last = agent.session.events.findLast(event => event.type === 'approval/policy')
  return last?.type === 'approval/policy' && last.data.source === 'delegation'
}

/** The settings key for a workspace root: forward slashes, no trailing slash. */
function workspaceKey(root: string | undefined): string | undefined {
  if (root === undefined || root.length === 0) return undefined
  return root.replaceAll('\\', '/').replace(/\/+$/u, '')
}

/** The parsed rules for one shell: global rules plus the workspace's saved allow rules. */
function rulesFor(settings: ShellPermissionSettings, dialect: ShellDialect, root: string | undefined): PermissionRules {
  const parse = (sources: readonly string[]): ShellRule[] => sources.map(parseRule).filter(rule => rule.dialect === dialect)
  const saved = root === undefined ? [] : settings.workspaces[root]?.allow ?? []
  return { allow: parse([...settings.allow, ...saved]), ask: parse(settings.ask), deny: parse(settings.deny) }
}

/** Reject malformed rules when settings load, so a typo fails loud instead of never matching. */
function validate(settings: ShellPermissionSettings): void {
  for (const source of [...settings.allow, ...settings.ask, ...settings.deny]) parseRule(source)
  for (const workspace of Object.values(settings.workspaces)) for (const source of workspace.allow) parseRule(source)
}

export default ShellPermissionPolicy
