/**
 * The allow rule an approval prompt offers for "don't ask again".
 *
 * A command whose first two words are a program and a plain subcommand (`npm run`, `pnpm vitest`,
 * `cargo test`) gets the prefix rule `<program> <subcommand> *`, so later runs with other
 * arguments are covered. Anything else gets an exact rule for the command as written.
 *
 * @module @elemental/shell-permission-policy/suggest
 */

import type { ShellDialect } from '@elemental/shell'
import { allowWords } from './words.ts'

/** Programs that run another program: a prefix rule on them would allow anything. */
const RUNNERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh', 'env', 'xargs', 'command', 'builtin',
  'nice', 'nohup', 'timeout', 'time', 'stdbuf', 'watch', 'sudo', 'doas', 'su', 'start-process', 'invoke-expression', 'iex',
])

/** A plain subcommand word. */
const SUBCOMMAND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

const TOOL: Readonly<Record<ShellDialect, string>> = { bash: 'bash', pwsh: 'pwsh' }

/**
 * Suggest an allow rule covering one simple command.
 * @param words - the command's words as split.
 * @param dialect - the shell it runs in.
 * @returns the rule in rule syntax, such as `bash(npm run *)`.
 */
export function suggestRule(words: readonly string[], dialect: ShellDialect): string {
  const rest = allowWords(words)
  const [program, subcommand] = rest
  // An assignment left after the safe ones are dropped changes what runs: only an exact rule fits.
  if (program !== undefined && subcommand !== undefined && !program.includes('=')
    && !RUNNERS.has(program.toLowerCase()) && SUBCOMMAND.test(subcommand)) {
    return `${TOOL[dialect]}(${program} ${subcommand} *)`
  }
  return `${TOOL[dialect]}(${words.join(' ').replaceAll('*', '\\*')})`
}
