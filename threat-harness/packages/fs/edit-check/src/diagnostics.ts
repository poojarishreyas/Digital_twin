/**
 * Pure parsing and comparison of checker output: which lines are diagnostics for the checked
 * file, which of them a change introduced, and the notice the model sees.
 * @module @elemental/edit-check/diagnostics
 */

import { isAbsolute, resolve } from 'node:path'

/** One diagnostic a checker reported for the checked file. */
export interface Diagnostic {
  /** 1-based line the checker reported. */
  line: number
  /** The diagnostic text after the location, e.g. `F821 Undefined name `x``. */
  message: string
}

/**
 * Location prefixes checkers print before a message, most specific first: `file(line,col):
 * message` (tsc) and `file:line[:col]: message` (ruff, eslint's unix format, gcc, go vet,
 * `cargo --message-format=short`).
 */
const LOCATION_PATTERNS: readonly RegExp[] = [
  /^(?<file>.+?)\((?<line>\d+),\d+\):\s*(?<message>\S.*)$/u,
  /^(?<file>.+?):(?<line>\d+)(?::\d+)?:\s*(?<message>\S.*)$/u,
]

/** File names checkers print for text they read from stdin. */
const STDIN_NAMES: ReadonlySet<string> = new Set(['-', '<stdin>', 'stdin'])

/**
 * Whether a file name a checker printed names the checked file.
 * @param printed - the file part of a diagnostic line.
 * @param path - the checked file's path.
 * @param cwd - the directory the checker ran in, which relative names resolve against.
 */
function namesFile(printed: string, path: string, cwd: string): boolean {
  if (STDIN_NAMES.has(printed)) return true
  return resolve(cwd, printed) === (isAbsolute(path) ? resolve(path) : resolve(cwd, path))
}

/**
 * The diagnostics a checker printed for one file, in output order. Lines for other files and
 * lines with no recognized location are ignored.
 * @param output - the checker's combined stdout and stderr.
 * @param path - the checked file's path.
 * @param cwd - the directory the checker ran in.
 * @returns the file's diagnostics.
 */
export function parseDiagnostics(output: string, path: string, cwd: string): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/u, '').trim()
    for (const pattern of LOCATION_PATTERNS) {
      const groups = pattern.exec(line)?.groups
      if (groups === undefined) continue
      // Both patterns define all three groups, so a match always carries them.
      const { file, line: number, message } = groups as { file: string; line: string; message: string }
      if (namesFile(file, path, cwd)) found.push({ line: Number(number), message })
      break
    }
  }
  return found
}

/**
 * The diagnostics in `after` that `before` did not already have. Lines move with every edit, so
 * diagnostics are matched by message: each earlier diagnostic cancels one identical message.
 * @param before - diagnostics of the earlier text.
 * @param after - diagnostics of the changed text.
 * @returns the unmatched diagnostics of `after`, in order.
 */
export function introducedDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
  const remaining = new Map<string, number>()
  for (const diagnostic of before) remaining.set(diagnostic.message, (remaining.get(diagnostic.message) ?? 0) + 1)
  return after.filter((diagnostic) => {
    const count = remaining.get(diagnostic.message) ?? 0
    if (count === 0) return true
    remaining.set(diagnostic.message, count - 1)
    return false
  })
}

/**
 * The line appended to an `edit` or `write` result whose checker found something.
 * @param checker - the configured checker's name.
 * @param diagnostics - the diagnostics to report; must be non-empty.
 * @param introduced - `true` when they are new since the text before the change, `false` when
 *   there was no earlier result to compare with and they are every diagnostic in the file.
 * @param maxListed - how many to list before counting the rest.
 * @returns the bracketed notice.
 */
export function formatDiagnosticNotice(
  checker: string,
  diagnostics: readonly Diagnostic[],
  introduced: boolean,
  maxListed: number,
): string {
  const count = diagnostics.length
  const noun = count === 1 ? 'diagnostic' : 'diagnostics'
  const listed = diagnostics.slice(0, maxListed).map(diagnostic => `L${diagnostic.line}: ${diagnostic.message}`).join('; ')
  const more = count > maxListed ? `; and ${count - maxListed} more` : ''
  const lead = introduced ? `this change introduced ${count} ${noun}` : `the file has ${count} ${noun} after this change`
  return `[Shadow check (${checker}): ${lead}. ${listed}${more}.]`
}
