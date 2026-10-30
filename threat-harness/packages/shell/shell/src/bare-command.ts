/**
 * Recognize a shell command that only reads a file or searches files, such as a bare `cat`,
 * `rg`, or `Get-Content`, and cap its model-facing output. The harness's own `read`, `grep`, and
 * `glob` tools do these jobs with line numbers, paging, and the read record that `edit` relies
 * on; a shell command bypasses all three. A capped result says which tool to use instead.
 *
 * Only a single simple command counts. Anything with a pipeline, a list, a redirection, a
 * substitution, a subshell, or a `find` action (`-exec`, `-delete`) is left alone, because its
 * output is no longer just the file or the search.
 *
 * @module @elemental/shell/bare-command
 */

/** The shell dialect a command is written in. */
export type ShellDialect = 'bash' | 'pwsh'

/** A recognized bare command. */
export interface BareCommand {
  /** The command name as written, without its directory, e.g. `cat` or `Get-Content`. */
  name: string
  /** `read` for commands that print a file, `search` for commands that find files or lines. */
  kind: 'read' | 'search'
}

const BASH_COMMANDS: Readonly<Record<string, BareCommand['kind']>> = {
  cat: 'read', head: 'read', tail: 'read',
  rg: 'search', grep: 'search', egrep: 'search', fgrep: 'search', find: 'search',
}

/** PowerShell names are case-insensitive; keys are lowercase. */
const PWSH_COMMANDS: Readonly<Record<string, BareCommand['kind']>> = {
  'get-content': 'read', gc: 'read', cat: 'read', type: 'read',
  'select-string': 'search', sls: 'search', 'get-childitem': 'search', gci: 'search', dir: 'search', ls: 'search',
}

/** `find` primaries that act on what they find, or write it somewhere: the output is not a search result. */
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])

/** Characters that start a pipeline, list, redirection, substitution, subshell, or block outside quotes. */
const OPERATORS: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set(['|', ';', '&', '>', '<', '`', '(', ')', '\n', '\r']),
  pwsh: new Set(['|', ';', '&', '>', '<', '(', ')', '{', '}', '\n', '\r']),
}

/** The dialect's escape character outside single quotes. */
const ESCAPE: Readonly<Record<ShellDialect, string>> = { bash: '\\', pwsh: '`' }

/**
 * Split a command into words, or return `undefined` when it contains an operator outside quotes.
 * Quotes group characters and are removed; `$(`, `${`, and backticks count as operators in bash
 * because their output becomes part of the command.
 */
function words(command: string, dialect: ShellDialect): string[] | undefined {
  const operators = OPERATORS[dialect]
  const escape = ESCAPE[dialect]
  const found: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | '\'' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    if (quote === '\'') {
      if (char === '\'') quote = undefined
      else word += char
      continue
    }
    if (char === escape && index + 1 < command.length) {
      word += command.charAt(index + 1)
      inWord = true
      index += 1
      continue
    }
    if (char === '$' && command.charAt(index + 1) === '(') return undefined
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (dialect === 'bash' && char === '`') return undefined
      else word += char
      continue
    }
    if (operators.has(char)) return undefined
    if (char === '"' || char === '\'') {
      quote = char
      inWord = true
    } else if (/\s/u.test(char)) {
      if (inWord) found.push(word)
      word = ''
      inWord = false
    } else {
      word += char
      inWord = true
    }
  }
  // An unterminated quote is not a command this check understands.
  if (quote !== undefined) return undefined
  if (inWord) found.push(word)
  return found
}

/**
 * Recognize a single simple command that only reads a file or searches files.
 * @param command - the command text as the model wrote it.
 * @param dialect - the shell it runs in.
 * @returns the command's name and kind, or `undefined` when it is anything else.
 */
export function bareCommand(command: string, dialect: ShellDialect): BareCommand | undefined {
  const parts = words(command, dialect)
  if (parts === undefined) return undefined
  // Leading `NAME=value` assignments are environment for the command, not the command.
  const start = dialect === 'bash' ? parts.findIndex(part => !/^[A-Za-z_]\w*=/u.test(part)) : 0
  const first = parts[start]
  if (first === undefined) return undefined
  const name = first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1)
  const table = dialect === 'bash' ? BASH_COMMANDS : PWSH_COMMANDS
  const key = dialect === 'bash' ? name : name.toLowerCase()
  if (!Object.hasOwn(table, key)) return undefined
  if (key === 'find' && parts.some(part => FIND_ACTIONS.has(part))) return undefined
  return { name, kind: table[key] as BareCommand['kind'] }
}

const encoder = new TextEncoder()

/** UTF-8 size of `text`. */
function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Trailing `[...]` lines a shell result ends with, such as `[exit code: 1]`; they survive the cap. */
function trailingMarkers(lines: readonly string[]): number {
  let count = 0
  while (count < lines.length && /^\[.*\]$/u.test(lines[lines.length - 1 - count] as string)) count += 1
  return count
}

/**
 * Cap a bare command's model-facing output: keep whole lines from the start up to `maxBytes`,
 * keep the result's trailing status markers, and say which harness tool does the job instead.
 * Output within the cap is returned unchanged.
 * @param text - the rendered result text.
 * @param command - the recognized command.
 * @param maxBytes - the UTF-8 budget for kept output lines, notice excluded.
 * @returns the capped text.
 */
export function capBareOutput(text: string, command: BareCommand, maxBytes: number): string {
  const total = byteLength(text)
  if (total <= maxBytes) return text
  const lines = text.split('\n')
  const markers = lines.splice(lines.length - trailingMarkers(lines))
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const size = byteLength(line) + 1
    if (used + size > maxBytes) break
    kept.push(line)
    used += size
  }
  // A first line longer than the whole budget (minified code, one-line JSON) keeps its start.
  const first = lines[0] as string
  if (kept.length === 0) {
    let cut = ''
    for (const char of first) {
      if (byteLength(cut + char) > maxBytes) break
      cut += char
    }
    kept.push(cut)
    used = byteLength(cut)
  }
  const advice = command.kind === 'read'
    ? 'Use the read tool to read files: it numbers lines, pages with offset and limit, and records the read that edit requires.'
    : 'Use the grep tool to search file contents and the glob tool to find files: they page their results and stay within the context budget.'
  const notice = `[Output of \`${command.name}\` capped at ${used} of ${total} bytes. ${advice}]`
  return [...kept, notice, ...markers].join('\n')
}
