/**
 * Permission rules for shell commands and their evaluation.
 *
 * A rule names a shell tool and a command pattern: `bash(<pattern>)` or `pwsh(<pattern>)`
 * (`Bash(…)` and `PowerShell(…)` are accepted spellings). A pattern is an exact command, a
 * prefix written `<prefix>:*`, or a wildcard pattern where `*` matches any text and a trailing
 * ` *` also matches the bare prefix (`git log *` matches `git log`). `\*` is a literal star.
 * PowerShell patterns match case-insensitively.
 *
 * A command line is judged one simple command at a time (see `splitCommand`): a deny rule on any
 * command denies the line, every command must be allowed for the line to be allowed, and
 * anything else asks. A line that cannot be split asks unless a rule names it exactly.
 *
 * @module @elemental/shell-permission-policy/rules
 */

import { splitCommand } from '@elemental/shell'
import type { ShellDialect } from '@elemental/shell'
import { isReadOnlyCommand } from './allowlist.ts'
import { allowWords, guardWords } from './words.ts'
import { suggestRule } from './suggest.ts'
import type { PermissionRules, RuleEvaluation } from './types.ts'

/** A parsed rule. */
export interface ShellRule {
  /** The rule as written, for diagnostics. */
  readonly source: string
  /** The shell the rule applies to. */
  readonly dialect: ShellDialect
  /** Whether a command text matches the rule. */
  readonly matches: (text: string) => boolean
}

const TOOL_NAMES: Readonly<Record<string, ShellDialect>> = {
  bash: 'bash', Bash: 'bash', pwsh: 'pwsh', PowerShell: 'pwsh',
}

/**
 * Parse one rule.
 * @param source - the rule text, such as `bash(npm run *)`.
 * @returns the parsed rule.
 * @throws {Error} when the text is not `<tool>(<pattern>)` for a known shell tool or the pattern is empty.
 */
export function parseRule(source: string): ShellRule {
  const match = /^([A-Za-z]+)\((.*)\)$/su.exec(source.trim())
  const dialect = match === null ? undefined : TOOL_NAMES[match[1] as string]
  const pattern = match?.[2]?.trim() ?? ''
  if (dialect === undefined || pattern.length === 0) {
    throw new Error(`invalid shell permission rule ${JSON.stringify(source)}: expected bash(<command pattern>) or pwsh(<command pattern>)`)
  }
  return { source, dialect, matches: patternMatcher(pattern, dialect) }
}

/**
 * Compile one command pattern into a matcher over normalized command text.
 * @param pattern - an exact command, a `<prefix>:*` prefix, or a `*` wildcard pattern.
 * @param dialect - the shell the pattern is written for; PowerShell matches case-insensitively.
 * @returns a function testing one command's text.
 */
export function patternMatcher(pattern: string, dialect: ShellDialect): (text: string) => boolean {
  const normalized = collapse(pattern)
  const fold = (text: string): string => dialect === 'pwsh' ? text.toLowerCase() : text
  const prefix = /^(.+):\*$/su.exec(normalized)?.[1]
  if (prefix !== undefined) {
    const wanted = fold(prefix)
    return (text) => {
      const value = fold(collapse(text))
      return value === wanted || value.startsWith(`${wanted} `)
    }
  }
  if (!/(?<!\\)\*/u.test(normalized)) {
    const wanted = fold(normalized.replaceAll('\\*', '*'))
    return text => fold(collapse(text)) === wanted
  }
  let source = ''
  let stars = 0
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized.charAt(index)
    if (char === '\\' && normalized.charAt(index + 1) === '*') {
      source += '\\*'
      index += 1
    } else if (char === '*') {
      source += '.*'
      stars += 1
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
    }
  }
  // `git log *` also matches a bare `git log`.
  if (stars === 1 && source.endsWith(' .*')) source = `${source.slice(0, -3)}( .*)?`
  const regex = new RegExp(`^${source}$`, dialect === 'pwsh' ? 'isu' : 'su')
  return text => regex.test(collapse(text))
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

/**
 * Judge a command line against the rules and the read-only list.
 * @param command - the command text as the model wrote it.
 * @param dialect - the shell it runs in.
 * @param rules - the rules for this shell, already parsed.
 * @returns the verdict, why, and the allow rules that would cover the commands still asking.
 */
export function evaluate(command: string, dialect: ShellDialect, rules: PermissionRules): RuleEvaluation {
  const commands = splitCommand(command, dialect)
  if (commands === undefined) {
    // Unsplittable text is judged as a whole: only exact and wildcard rules can name it.
    const denied = rules.deny.find(rule => rule.matches(command))
    if (denied !== undefined) return { behavior: 'deny', reason: `denied by rule ${denied.source}` }
    const asked = rules.ask.find(rule => rule.matches(command))
    if (asked !== undefined) return { behavior: 'ask', reason: `rule ${asked.source} always asks`, byRule: true, suggestions: [] }
    const allowed = rules.allow.find(rule => rule.matches(command))
    if (allowed !== undefined) return { behavior: 'allow', reason: `allowed by rule ${allowed.source}` }
    return {
      behavior: 'ask',
      reason: 'this command contains substitution, grouping, or file redirection, so no rule can approve it in advance',
      byRule: false,
      suggestions: [],
    }
  }
  const suggestions: string[] = []
  let askedByRule: string | undefined
  let unapproved = 0
  for (const words of commands) {
    const guarded = guardWords(words).join(' ')
    const denied = rules.deny.find(rule => rule.matches(guarded))
    if (denied !== undefined) return { behavior: 'deny', reason: `denied by rule ${denied.source}` }
    const asked = rules.ask.find(rule => rule.matches(guarded))
    if (asked !== undefined) {
      askedByRule ??= asked.source
      continue
    }
    const allowable = allowWords(words)
    if (rules.allow.some(rule => rule.matches(allowable.join(' '))) || isReadOnlyCommand(allowable, dialect)) continue
    unapproved += 1
    const suggestion = suggestRule(words, dialect)
    if (!suggestions.includes(suggestion)) suggestions.push(suggestion)
  }
  // An explicit ask rule asks every time, so no "always" rule is offered for it.
  if (askedByRule !== undefined) return { behavior: 'ask', reason: `rule ${askedByRule} always asks`, byRule: true, suggestions: [] }
  if (unapproved === 0) return { behavior: 'allow', reason: 'every command is allowed by a rule or is read-only' }
  return { behavior: 'ask', reason: 'no permission rule allows this command', byRule: false, suggestions }
}

/**
 * Whether every simple command in a line matches one of the sandbox exclusion patterns.
 * @param command - the command text.
 * @param dialect - the shell it runs in.
 * @param patterns - exclusion patterns in rule-pattern syntax, without a tool name.
 * @returns `true` only when the line splits and each of its commands matches a pattern.
 */
export function matchesExcluded(command: string, dialect: ShellDialect, patterns: readonly ((text: string) => boolean)[]): boolean {
  if (patterns.length === 0) return false
  const commands = splitCommand(command, dialect)
  if (commands === undefined || commands.length === 0) return false
  return commands.every(words => patterns.some(matches => matches(allowWords(words).join(' '))))
}
