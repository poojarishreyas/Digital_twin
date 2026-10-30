/**
 * The syntax shadow check behind `edit` and `write`: parse the file before and after a change
 * with the bundled tree-sitter grammars and report the syntax errors the change introduced, so
 * the model fixes them on its next step instead of discovering them in a build several edits
 * later.
 * @module @elemental/tool-fs/src/syntax-check
 */

import type { SyntaxNode } from './read-fold.ts'
import { grammarForPath } from './read-syntax.ts'
import type { SyntaxParsers } from './read-syntax.ts'

/** One syntax error tree-sitter found, located by its 1-based line. */
export interface SyntaxProblem {
  /** 1-based line where the error starts. */
  line: number
  /** What is wrong, without the line: `missing "}"` or `unexpected "=> {"`. */
  message: string
}

/** How `edit` and `write` run the syntax shadow check. */
export interface SyntaxCheck {
  /** Whether the check runs; `false` leaves every result as it was. */
  enabled: boolean
  /** The shared tree-sitter parsers. */
  parsers: SyntaxParsers
  /** Files at least this many UTF-8 bytes are not checked. */
  maxBytes: number
  /** How many introduced errors a notice lists before summarizing the rest. */
  maxListed: number
}

/** JSON schema of the introduced-error list in `edit` and `write` results. */
export const SYNTAX_ERRORS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      line: { type: 'integer', required: true },
      message: { type: 'string', required: true },
    },
  },
} as const

/** The longest excerpt of unparsable text an `unexpected` message quotes. */
const EXCERPT_CHARS = 40

/** A missing token named by a word (`identifier`) reads as prose; punctuation is quoted. */
function missingMessage(type: string): string {
  return /^[a-z][a-z_]+$/u.test(type) ? `missing ${type.replaceAll('_', ' ')}` : `missing "${type}"`
}

/** The first non-blank line of an error node's text, shortened to {@link EXCERPT_CHARS}. */
function unexpectedMessage(text: string): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line.length > 0)
  if (first === undefined) return 'syntax error'
  const excerpt = first.length > EXCERPT_CHARS ? `${first.slice(0, EXCERPT_CHARS)}…` : first
  return `unexpected "${excerpt}"`
}

/**
 * Every error and missing node in a parsed tree, outermost first in source order. An error
 * node's descendants are not reported separately: the outer node already covers their text.
 * @param root - the parsed file's root node.
 * @returns the problems, ordered by position.
 */
export function syntaxProblems(root: SyntaxNode): SyntaxProblem[] {
  const problems: SyntaxProblem[] = []
  const visit = (node: SyntaxNode): void => {
    if (node.isMissing) {
      problems.push({ line: node.startPosition.row + 1, message: missingMessage(node.type) })
      return
    }
    if (node.isError) {
      problems.push({ line: node.startPosition.row + 1, message: unexpectedMessage(node.text) })
      return
    }
    if (!node.hasError) return
    for (const child of node.children) if (child !== null) visit(child)
  }
  visit(root)
  return problems
}

/**
 * The problems in `after` that `before` did not already have. Lines move with every edit, so
 * problems are matched by message: each problem in `before` cancels one identical message in
 * `after`, and the rest are new.
 * @param before - problems of the earlier text.
 * @param after - problems of the changed text.
 * @returns the unmatched problems of `after`, in order.
 */
export function introducedProblems(before: readonly SyntaxProblem[], after: readonly SyntaxProblem[]): SyntaxProblem[] {
  const remaining = new Map<string, number>()
  for (const problem of before) remaining.set(problem.message, (remaining.get(problem.message) ?? 0) + 1)
  return after.filter((problem) => {
    const count = remaining.get(problem.message) ?? 0
    if (count === 0) return true
    remaining.set(problem.message, count - 1)
    return false
  })
}

/**
 * The syntax errors a change introduced into a file whose language has a bundled grammar.
 * Best-effort: an unsupported language, a file of `maxBytes` or more, or a grammar that fails
 * to load yields no problems, so the check can never fail the edit that already landed.
 * @param parsers - the shared tree-sitter parsers.
 * @param path - the file's path; its extension selects the grammar.
 * @param before - the text before the change, or `null` for a new file.
 * @param after - the text after the change.
 * @param maxBytes - files at least this large are not checked.
 * @returns the introduced problems, in order; empty when there are none or the check did not run.
 */
export async function checkSyntax(
  parsers: SyntaxParsers,
  path: string,
  before: string | null,
  after: string,
  maxBytes: number,
): Promise<SyntaxProblem[]> {
  const grammar = grammarForPath(path)
  if (grammar === undefined || Buffer.byteLength(after, 'utf8') >= maxBytes) return []
  const problemsOf = async (text: string): Promise<SyntaxProblem[]> => {
    const parsed = await parsers.parse(grammar, text)
    try {
      return syntaxProblems(parsed.root)
    } finally {
      parsed.dispose()
    }
  }
  try {
    const afterProblems = await problemsOf(after)
    // A clean result needs no baseline, so the common case parses once.
    if (afterProblems.length === 0) return []
    return introducedProblems(before === null ? [] : await problemsOf(before), afterProblems)
  } catch {
    return []
  }
}

/**
 * Run the configured shadow check on one change.
 * @param syntax - the check's configuration.
 * @param path - the changed file's path.
 * @param before - the text before the change, or `null` for a new file.
 * @param after - the text after the change.
 * @returns the introduced problems; empty when the check is off or found none.
 */
export async function shadowCheck(syntax: SyntaxCheck, path: string, before: string | null, after: string): Promise<SyntaxProblem[]> {
  return syntax.enabled ? checkSyntax(syntax.parsers, path, before, after, syntax.maxBytes) : []
}

/**
 * A tool's confirmation text, followed by the shadow-check notice when the change introduced
 * syntax errors.
 * @param text - the confirmation the tool returns without the check.
 * @param problems - the introduced problems, absent when there were none.
 * @param maxListed - how many problems the notice lists.
 * @returns the model-facing text.
 */
export function withSyntaxNotice(text: string, problems: readonly SyntaxProblem[] | undefined, maxListed: number): string {
  return problems === undefined ? text : `${text}\n${formatSyntaxNotice(problems, maxListed)}`
}

/**
 * The line appended to an `edit` or `write` result that introduced syntax errors.
 * @param problems - the introduced problems; must be non-empty.
 * @param maxListed - how many problems to list before summarizing the rest.
 * @returns the bracketed notice.
 */
export function formatSyntaxNotice(problems: readonly SyntaxProblem[], maxListed: number): string {
  const listed = problems.slice(0, maxListed).map(problem => `L${problem.line}: ${problem.message}`).join('; ')
  const more = problems.length > maxListed ? `; and ${problems.length - maxListed} more` : ''
  const noun = problems.length === 1 ? 'syntax error' : 'syntax errors'
  return `[Shadow check: this change introduced ${problems.length} ${noun}. ${listed}${more}. Fix ${problems.length === 1 ? 'it' : 'them'} before editing other files or building.]`
}
