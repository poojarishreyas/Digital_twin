/**
 * Split a shell command line into the simple commands it runs, for policies that judge each
 * command on its own (such as permission rules). A list or pipeline (`&&`, `||`, `;`, `|`, a
 * newline, and bash's `&`) separates simple commands; quotes group characters and are removed.
 *
 * Only what can be judged from the text is split. A command whose effect depends on text the
 * shell computes or reads elsewhere — command substitution (`$(…)`, backticks), a subshell or
 * PowerShell expression (`(…)`), a PowerShell script block (`{…}`), a here-document, or a
 * redirection to or from a file — returns `undefined`, so a caller treats it as unknown.
 * Redirections that only merge or discard output (`2>&1`, `>/dev/null`, `*>$null`) are dropped.
 *
 * @module @elemental/shell/command-split
 */

import type { ShellDialect } from './bare-command.ts'

/** The dialect's escape character outside single quotes. */
const ESCAPE: Readonly<Record<ShellDialect, string>> = { bash: '\\', pwsh: '`' }

/** Characters that end a simple command outside quotes (`&&` and `||` are matched as pairs first). */
const SEPARATORS: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set([';', '|', '&', '\n', '\r']),
  pwsh: new Set([';', '|', '\n', '\r']),
}

/** Characters that open text the shell computes or groups; a command containing one is not split. */
const GROUPS: Readonly<Record<ShellDialect, ReadonlySet<string>>> = {
  bash: new Set(['(', ')', '`']),
  pwsh: new Set(['(', ')', '{', '}']),
}

/** Redirection targets that discard output: the redirection writes no file the command names. */
const DISCARD_TARGETS: ReadonlySet<string> = new Set(['/dev/null', '$null', 'nul', 'NUL'])

/**
 * Split a command line into its simple commands, each as its words.
 * @param command - the command text as the model wrote it.
 * @param dialect - the shell it runs in.
 * @returns one word list per simple command, in order, with empty commands omitted; or
 *   `undefined` when the command contains text this split cannot judge (see the module notes).
 */
export function splitCommand(command: string, dialect: ShellDialect): string[][] | undefined {
  const escape = ESCAPE[dialect]
  const separators = SEPARATORS[dialect]
  const groups = GROUPS[dialect]
  const commands: string[][] = []
  let current: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | '\'' | undefined
  // A redirection operator waits for its target word.
  let redirect: 'out' | undefined

  const endWord = (): boolean => {
    if (!inWord) return true
    if (redirect === 'out') {
      redirect = undefined
      if (!DISCARD_TARGETS.has(word)) return false
    } else {
      current.push(word)
    }
    word = ''
    inWord = false
    return true
  }
  const endCommand = (): boolean => {
    if (!endWord() || redirect !== undefined) return false
    if (current.length > 0) commands.push(current)
    current = []
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    const next = command.charAt(index + 1)
    if (quote === '\'') {
      if (char === '\'') quote = undefined
      else word += char
      continue
    }
    if (char === escape && index + 1 < command.length) {
      // A line continuation (LF or CRLF) joins lines; any other escaped character is literal.
      if (next !== '\n' && next !== '\r') {
        word += next
        inWord = true
      } else if (next === '\r' && command.charAt(index + 2) === '\n') {
        index += 1
      }
      index += 1
      continue
    }
    if (char === '$' && next === '(') return undefined
    if (quote === '"') {
      if (char === '"') quote = undefined
      else if (dialect === 'bash' && char === '`') return undefined
      else word += char
      continue
    }
    if (groups.has(char)) return undefined
    if (char === '"' || char === '\'') {
      quote = char
      inWord = true
      continue
    }
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      if (!endCommand()) return undefined
      index += 1
      continue
    }
    if (char === '>' || char === '<') {
      if (char === '<' || redirect !== undefined) return undefined
      // `2>`, `*>`: the word before the operator names the stream, not an argument.
      if (inWord && /^(?:\d|\*)$/u.test(word)) {
        word = ''
        inWord = false
      } else {
        // No redirection is pending here, so the word before the operator is an argument.
        endWord()
      }
      if (next === '>') index += 1
      // `>&1`, `2>&1`: merges streams, writes no file.
      if (command.charAt(index + 1) === '&') {
        const fd = /^&(\d)/u.exec(command.slice(index + 1))
        if (fd === null) return undefined
        index += fd[0].length
        continue
      }
      redirect = 'out'
      continue
    }
    if (separators.has(char)) {
      if (!endCommand()) return undefined
      continue
    }
    // PowerShell's call operator `& 'path' args` runs the command that follows.
    if (dialect === 'pwsh' && char === '&' && !inWord) continue
    if (/\s/u.test(char)) {
      if (!endWord()) return undefined
      continue
    }
    word += char
    inWord = true
  }
  // An unterminated quote or a redirection without a target is not a command this split understands.
  if (quote !== undefined || !endCommand()) return undefined
  return commands
}
