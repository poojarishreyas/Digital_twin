/**
 * Types for shell command permission rules and settings.
 * @module @elemental/shell-permission-policy/types
 */

import type { ShellRule } from './rules.ts'

/** The parsed rules for one shell, by effect. */
export interface PermissionRules {
  readonly allow: readonly ShellRule[]
  readonly ask: readonly ShellRule[]
  readonly deny: readonly ShellRule[]
}

/** The verdict on one command line. */
export type RuleEvaluation =
  | { readonly behavior: 'allow'; readonly reason: string }
  | { readonly behavior: 'deny'; readonly reason: string }
  | {
    readonly behavior: 'ask'
    readonly reason: string
    /** Whether an ask rule, rather than a missing allow rule, made the line ask. */
    readonly byRule: boolean
    /** Allow rules that would cover the commands still asking; empty when none can be offered. */
    readonly suggestions: readonly string[]
  }

/** Rules saved for one workspace from the approval prompt. */
export interface WorkspacePermissions {
  /** Allow rules, in rule syntax. */
  allow: string[]
}

/** The sandbox switches for shell commands. */
export interface ShellSandboxSettings {
  /**
   * Run commands inside the OS sandbox when the session's mode is `workspace-write`. When
   * `false`, commands run outside it and permission rules or the approval prompt guard them.
   */
  enabled: boolean
  /** Command patterns (rule-pattern syntax, no tool name) that run outside the sandbox even when it is enabled. */
  excludedCommands: string[]
}

/** The `shell-permissions` settings section. */
export interface ShellPermissionSettings {
  /** Whether and where commands run inside the OS sandbox. */
  sandbox: ShellSandboxSettings
  /** Rules that let a command run without asking. */
  allow: string[]
  /** Rules that make a command ask every time, even inside the sandbox. */
  ask: string[]
  /** Rules that refuse a command. */
  deny: string[]
  /** Allow rules saved per workspace root (forward slashes) by "don't ask again". */
  workspaces: Record<string, WorkspacePermissions>
}
