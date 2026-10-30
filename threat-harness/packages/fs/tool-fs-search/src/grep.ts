/**
 * The model-facing `grep` tool: search file contents with a ripgrep regular
 * expression. Execution spawns the packaged ripgrep binary
 * (`@vscode/ripgrep`) directly through the subprocess seam with a plain argv
 * vector using a fixed line-oriented `rg --json` command so file path, line
 * number, and line text parse without colon-splitting ambiguity — this module
 * owns the model-facing schema, argument validation, argv construction,
 * `--json` record parsing, per-line preview retention, match retention,
 * grouping, and formatting; process concerns stay behind `ctx.subprocess`.
 *
 * @module @elemental/tool-fs-search/grep
 */

import type { Context } from '@elemental/cordis'
import { isAbsolute, resolve } from 'node:path'
import type { } from '@elemental/fs'
import { declarationScopes, innermostScope } from '@elemental/tool-fs'
import type { DeclarationScope } from '@elemental/tool-fs'
import { defineTool } from '@elemental/tools'
import type { GenericCallView, SearchResultView, ToolExecution, ToolResult } from '@elemental/tools'
import type { SpillRef } from '@elemental/spill'
import type { GrepMatch } from './search-core.ts'
import { SearchError, previewLine, retainGrepMatches, runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { grepSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * Default cap on flat matches retained inline by one `grep` call (the
 * `grepMaxMatches` config), matching Claude Code's default `GrepTool`
 * `head_limit`.
 */
export const GREP_MAX_MATCHES = 250

/**
 * Default cap in bytes on one matched-line preview (the `grepMaxLineBytes`
 * config); the cut preserves UTF-8 boundaries.
 */
export const GREP_MAX_LINE_BYTES = 2000

/** Default `head_limit`: files or matches one `grep` page shows (the `grepDefaultHeadLimit` config). */
export const GREP_DEFAULT_HEAD_LIMIT = 100

/** Default cap on `context`, `before_context`, and `after_context` (the `grepMaxContextLines` config). */
export const GREP_MAX_CONTEXT_LINES = 5

/** Default size below which a matched file is parsed for enclosing declarations (the `grepScopeMaxFileBytes` config). */
export const GREP_SCOPE_MAX_FILE_BYTES = 1024 * 1024

/** Resolved grep-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GrepToolCaps {
  /** Max flat matches retained inline, and the largest accepted `head_limit`; later matches go to the formatted spill file. */
  maxMatches: number
  /** Files or matches one page shows when the call omits `head_limit`. */
  defaultHeadLimit: number
  /** Largest accepted `context`, `before_context`, or `after_context`. */
  maxContextLines: number
  /** Whether a `lines` page groups its matches under the signature of the declaration that contains them. */
  annotateScopes: boolean
  /** Files at least this many bytes are not parsed for enclosing declarations. */
  scopeMaxFileBytes: number
  /** Max bytes retained per matched-line preview. */
  maxLineBytes: number
  /** Max bytes of serialized `presentationMeta`; trailing file groups drop past it. */
  maxMetaBytes: number
  /** Cap on the complete raw `rg` stdout the tool will parse. */
  rawOutputMaxBytes: number
  /** Terminate-escalation grace period (ms) for the search process. */
  graceMs: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

/** Validated `grep` arguments that shape the ripgrep command. */
export interface GrepInput {
  pattern: string
  path?: string
  include?: string
  /** Match case-insensitively (`--ignore-case`). */
  ignoreCase?: boolean
  /** One ripgrep file type (`--type`), e.g. `ts` or `py`. */
  type?: string
  /** Context lines before each match (`--before-context`). */
  before?: number
  /** Context lines after each match (`--after-context`). */
  after?: number
}

/** The page of results one call shows. */
export interface GrepPage {
  /** Files or matches to skip. */
  offset: number
  /** Files or matches to show. */
  limit: number
}

/** Limits that bound `grep` arguments. */
export interface GrepArgLimits {
  /** Largest accepted context line count. */
  maxContextLines: number
  /** Largest accepted `head_limit`. */
  maxHeadLimit: number
  /** `head_limit` when the call omits it. */
  defaultHeadLimit: number
}

/**
 * What one `grep` call shows the model: matching file names with per-file
 * match counts (the default), or the matching lines themselves. Lines cost
 * far more context, and every later step resends them; most searches only
 * need to know which files to read.
 */
export type GrepOutputMode = 'files' | 'lines'

/** Raw `grep` tool arguments as the schema accepts them. */
type GrepArgs = {
  pattern: string
  path?: string
  include?: string
  output?: GrepOutputMode
  ignore_case?: boolean
  type?: string
  context?: number
  before_context?: number
  after_context?: number
  head_limit?: number
  offset?: number
}

/** A ripgrep file-type name: letters, digits, `_`, `+`, and `-`. */
const FILE_TYPE = /^[\w+-]+$/u

/** Reject a context line count that is not an integer from 0 to `max`. */
function contextLines(name: string, value: number | undefined, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer from 0 to ${max}`)
  return value
}

/**
 * Reject an `include` that is not ONE positive glob filter: blank strings,
 * negated patterns (`!…`), and comma-separated lists. A comma inside a brace
 * group is fine — `*.{ts,tsx}` is one glob with alternation, not a list.
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/** The argument limits of a default deployment. */
const DEFAULT_LIMITS: GrepArgLimits = {
  maxContextLines: GREP_MAX_CONTEXT_LINES,
  maxHeadLimit: GREP_MAX_MATCHES,
  defaultHeadLimit: GREP_DEFAULT_HEAD_LIMIT,
}

/**
 * Validate value constraints the schema DSL can't express: a non-EMPTY
 * `pattern` (whitespace is a legitimate regex), a non-blank `path` when given,
 * a single positive `include` glob, a plain ripgrep `type` name, and context
 * line counts from 0 to the configured cap, allowed only with `output: "lines"`.
 * Throws a plain `Error` (an ordinary tool argument error) otherwise.
 *
 * @param args - the schema-validated `grep` arguments.
 * @param limits - the deployment's argument limits; defaults to the shipped caps.
 * @returns the command-shaping input. `context` sets both sides; `before_context` and `after_context` override it.
 */
export function parseGrepArgs(args: GrepArgs, limits: GrepArgLimits = DEFAULT_LIMITS): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.include !== undefined) validateInclude(args.include)
  if (args.type !== undefined && !FILE_TYPE.test(args.type)) {
    throw new Error('type must be one ripgrep file type name, e.g. "ts" or "py"')
  }
  const context = contextLines('context', args.context, limits.maxContextLines)
  const before = contextLines('before_context', args.before_context, limits.maxContextLines) ?? context
  const after = contextLines('after_context', args.after_context, limits.maxContextLines) ?? context
  if ((before !== undefined || after !== undefined) && args.output !== 'lines') {
    throw new Error('context lines apply only to output "lines"')
  }
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
    ...args.ignore_case === true ? { ignoreCase: true } : {},
    ...args.type !== undefined ? { type: args.type } : {},
    ...before !== undefined && before > 0 ? { before } : {},
    ...after !== undefined && after > 0 ? { after } : {},
  }
}

/**
 * Validate and default the page a call asks for.
 * @param args - the schema-validated `grep` arguments.
 * @param limits - the deployment's argument limits.
 * @returns the page: `offset` defaults to 0 and `head_limit` to the configured default.
 */
export function parseGrepPage(args: Pick<GrepArgs, 'head_limit' | 'offset'>, limits: GrepArgLimits = DEFAULT_LIMITS): GrepPage {
  const limit = args.head_limit ?? Math.min(limits.defaultHeadLimit, limits.maxHeadLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxHeadLimit) {
    throw new Error(`head_limit must be an integer from 1 to ${limits.maxHeadLimit}`)
  }
  const offset = args.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
  return { offset, limit }
}

/**
 * Build the fixed line-oriented `rg --json` argv for one `grep` call. Every
 * model-controlled value ({@link GrepInput.pattern}, {@link GrepInput.path},
 * {@link GrepInput.include}) is a plain argv element — no shell layer exists,
 * so no quoting applies; the pattern and include ride in `--flag=value` form
 * and the target behind `--`, so a leading-dash value can never be parsed as
 * a flag.
 *
 * @param input - the validated arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.ignoreCase === true) parts.push('--ignore-case')
  if (input.type !== undefined) parts.push(`--type=${input.type}`)
  if (input.before !== undefined) parts.push(`--before-context=${input.before}`)
  if (input.after !== undefined) parts.push(`--after-context=${input.after}`)
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * The uniform malformed-output failure: raw `rg --json` is an internal
 * transport, so missing or invalid response fields cause a search failure, not a partial result.
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(`grep received malformed ripgrep --json output (${detail})`, 'SEARCH_FAILED', cause !== undefined ? { cause } : undefined)
}

/** One parsed `rg --json` line record: a matched line or a context line around one. */
interface GrepRecord {
  kind: 'match' | 'context'
  line: GrepMatch
}

/**
 * Parse one `rg --json` NDJSON line into a matched or context line, `undefined`
 * for the framing record types (`begin`/`end`/`summary`). A line that is not
 * JSON, or a `match`/`context` record missing its path / line number / line
 * content, throws {@link SearchError} `SEARCH_FAILED`. A line that is not valid
 * UTF-8 (ripgrep sends base64 `bytes` instead of `text`) yields a placeholder
 * preview rather than failing the whole search.
 */
function parseRecord(line: string): GrepRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformedRecord('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformedRecord('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  // Other record types (begin/end/summary — and any future type) are
  // transport framing, not results: skipped, not malformed.
  if (record.type !== 'match' && record.type !== 'context') return undefined
  const kind = record.type
  if (typeof record.data !== 'object' || record.data === null) throw malformedRecord('a match record has no data')
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null ? (data.path as { text?: unknown }).text : undefined
  if (typeof pathText !== 'string') throw malformedRecord('a match record has no path text')
  if (typeof data.line_number !== 'number') throw malformedRecord('a match record has no line number')
  if (typeof data.lines !== 'object' || data.lines === null) throw malformedRecord('a match record has no line content')
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string') {
    return { kind, line: { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, '') } }
  }
  if (typeof lines.bytes === 'string') {
    return { kind, line: { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)' } }
  }
  throw malformedRecord('a match record has neither line text nor bytes')
}

/**
 * Parse complete `rg --json` stdout into flat matches, in output order (ripgrep
 * emits one file's matches contiguously). Only `match` records are consumed.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @returns the flat matches; empty for output with no match records.
 */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  return parseGrepRecords(stdout).matches
}

/**
 * Parse complete `rg --json` stdout into matched lines and the context lines
 * ripgrep printed around them, each in output order.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @returns the matched lines and the context lines.
 */
export function parseGrepRecords(stdout: string): { matches: GrepMatch[]; context: GrepMatch[] } {
  const matches: GrepMatch[] = []
  const context: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const record = parseRecord(line)
    if (record !== undefined) (record.kind === 'match' ? matches : context).push(record.line)
  }
  return { matches, context }
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body:
 * each file's display path, then one `Line N: <text>` row per match.
 *
 * @param matches - the flat matches to render.
 * @returns the grouped body text.
 */
export function formatGrepMatches(matches: GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/** A declaration that contains shown matches; a `lines` page groups its matches under the declaration's signature. */
export interface GrepScope {
  /** Display path of the file, as in the matches. */
  path: string
  /** Dotted declaration name, e.g. `Parser.parse`. */
  name: string
  /** 1-based line of the declaration's signature. */
  start: number
  /** 1-based last line of the declaration. */
  end: number
  /** The signature line's text, trimmed. */
  header: string
}

/** What one `lines` page renders, beyond the matches. */
export interface GrepLinesView {
  /** The page to show. */
  page: GrepPage
  /** Context lines ripgrep printed around the matches. */
  context: readonly GrepMatch[]
  /** How far context reaches before and after a match; lines further from every shown match are not shown. */
  window: { before: number; after: number }
  /** Declarations containing shown matches. */
  scopes: readonly GrepScope[]
  /** Max bytes of one shown line. */
  maxLineBytes: number
  /** Where the complete result was saved, when it was. */
  spillRef?: SpillRef
}

/** The innermost scope containing a line: the one whose signature starts last. */
function innermost(scopes: readonly GrepScope[], line: number): GrepScope | undefined {
  let found: GrepScope | undefined
  for (const scope of scopes) {
    if (scope.start <= line && line <= scope.end && (found === undefined || scope.start >= found.start)) found = scope
  }
  return found
}

/** The `Showing … of …` range and next-page hint shared by both output modes, or `undefined` for a complete first page. */
function pageFooter(noun: string, total: number, page: GrepPage, more: string): string | undefined {
  const end = Math.min(total, page.offset + page.limit)
  if (page.offset === 0 && end === total) return undefined
  const range = page.offset + 1 === end ? `${end}` : `${page.offset + 1}-${end}`
  if (end === total) return `Showing ${noun} ${range} of ${total}.`
  return `Showing ${noun} ${range} of ${total}. Use offset=${end} to see the next page${more}`
}

/**
 * Render one file's shown matches, with the context lines near them and a signature header
 * whenever the enclosing declaration changes. Context lines read `Line N- text`; a `--` row
 * separates runs that are not adjacent.
 */
function formatFileLines(path: string, matches: readonly GrepMatch[], view: GrepLinesView): string {
  const fileScopes = view.scopes.filter(scope => scope.path === path)
  const shown = new Set(matches.map(match => match.lineNumber))
  const near = (line: number): boolean =>
    matches.some(match => line >= match.lineNumber - view.window.before && line <= match.lineNumber + view.window.after)
  const rows = [
    ...matches.map(match => ({ number: match.lineNumber, text: match.line, isMatch: true })),
    ...view.context
      .filter(line => line.path === path && !shown.has(line.lineNumber) && near(line.lineNumber))
      .map(line => ({ number: line.lineNumber, text: line.line, isMatch: false })),
  ].sort((a, b) => a.number - b.number)
  const out = [path]
  const withContext = view.window.before > 0 || view.window.after > 0
  let previousLine: number | undefined
  let previousScope: GrepScope | undefined
  for (const row of rows) {
    if (withContext && previousLine !== undefined && row.number > previousLine + 1) out.push('--')
    const scope = fileScopes.length === 0 ? undefined : innermost(fileScopes, row.number)
    if (scope !== previousScope) {
      out.push(scope === undefined
        ? '[outside any declaration]'
        : `[L${scope.start} in ${scope.name}: ${previewLine(scope.header, view.maxLineBytes)}]`)
      previousScope = scope
    }
    out.push(`Line ${row.number}${row.isMatch ? ':' : '-'} ${previewLine(row.text, view.maxLineBytes)}`)
    previousLine = row.number
  }
  return out.join('\n')
}

/**
 * Format a `lines` result: a found-count header, the page's matches grouped by file (first-seen
 * order) with any context lines and enclosing-declaration headers, then a footer with the next
 * offset and, when it was saved, where the complete result is.
 *
 * @param matches - every match the search found.
 * @param view - the page, context, scopes, and line cap to render with.
 * @returns the model-facing text.
 */
export function formatGrepLines(matches: readonly GrepMatch[], view: GrepLinesView): string {
  const total = matches.length
  if (total === 0) return 'No matches found'
  const { page } = view
  if (page.offset >= total) return `No matches at offset ${page.offset}: the search found ${total} ${matchNoun(total)}.`
  const shown = matches.slice(page.offset, page.offset + page.limit)
  const end = page.offset + shown.length
  const header = page.offset > 0
    ? `Found ${total} matches; showing ${page.offset + 1}-${end}`
    : end < total ? `Found ${end} of ${total} matches` : `Found ${total} ${matchNoun(total)}`
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of shown) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const body = [...byFile].map(([path, group]) => formatFileLines(path, group, view)).join('\n\n')
  const saved = view.spillRef === undefined ? '' : ` Full grep result stored at: ${view.spillRef.locator}. ${view.spillRef.retrievalHint}`
  const more = view.spillRef === undefined ? ', or narrow pattern, path, or include.' : '.'
  const footer = pageFooter('matches', total, page, more)
  return footer === undefined ? `${header}\n\n${body}` : `${header}\n\n${body}\n\n(${footer}${end < total ? saved : ''})`
}

/**
 * Format the default `grep` result: a found-count header, then the page's matching files
 * (first-seen order) with their match counts, and a footer with the next offset when more
 * files remain.
 *
 * @param matches - every match the search found.
 * @param page - the files to show.
 * @returns the model-facing text.
 */
export function formatGrepFiles(matches: readonly GrepMatch[], page: GrepPage): string {
  if (matches.length === 0) return 'No matches found'
  const counts = new Map<string, number>()
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1)
  const files = [...counts]
  const header = `Found ${matches.length} ${matchNoun(matches.length)} in ${files.length} ${files.length === 1 ? 'file' : 'files'} `
    + '(match count per file in parentheses; pass output "lines" to see the matching lines)'
  if (page.offset >= files.length) return `${header}\n\n(No files at offset ${page.offset}.)`
  const body = files.slice(page.offset, page.offset + page.limit).map(([path, count]) => `${path} (${count})`).join('\n')
  const footer = pageFooter('files', files.length, page, ', or narrow pattern, path, or include.')
  return footer === undefined ? `${header}\n\n${body}` : `${header}\n\n${body}\n\n(${footer})`
}

/**
 * Pending-call presentation: a search card titled by the pattern (and target /
 * include filter).
 *
 * @param args - the raw tool arguments; `pattern`, `path`, and `include` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGrepCall(args: GrepArgs): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined ? ` (${args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (matches grouped by file, with the truncation signal). A UI
 * without a search card falls back to the raw `tool/result` content, so the view
 * carries no result text of its own. Malformed or absent metadata (an obsolete or
 * hand-edited replayed log) falls back to the generic card.
 *
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the projected metadata.
 * @returns the search card view, or `undefined` for the generic fallback.
 */
export function presentGrepResult(
  _args: GrepArgs,
  result: ToolResult,
): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'matches') return undefined
  return view
}

/** Output schema of one matched or context line. */
const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    lineNumber: { type: 'integer', required: true },
    line: { type: 'string', required: true },
  },
} as const

/** The `grep` result value. */
interface GrepValue {
  matches: GrepMatch[]
  context?: GrepMatch[]
  scopes?: GrepScope[]
}

/**
 * The declarations that contain the shown matches, read through `ctx.fs` and parsed with the
 * grammars `tool-fs` bundles. Best-effort: without a filesystem service, for a language
 * without a grammar, for a file of `maxFileBytes` or more, or when a file cannot be read, that
 * file's matches show without headers.
 *
 * @param ctx - the plugin context; reads use its optional `fs` service.
 * @param exec - the call, for its abort signal.
 * @param workdir - the directory ripgrep ran in; relative match paths resolve against it.
 * @param shown - the matches on the page, with ripgrep's paths.
 * @param maxFileBytes - files at least this large are not parsed.
 * @returns the containing declarations, keyed by ripgrep's path.
 */
async function enclosingScopes(
  ctx: Context,
  exec: ToolExecution,
  workdir: string,
  shown: readonly GrepMatch[],
  maxFileBytes: number,
): Promise<GrepScope[]> {
  const fs = ctx.get('fs')
  if (!fs) return []
  const linesByPath = new Map<string, number[]>()
  for (const match of shown) linesByPath.set(match.path, [...linesByPath.get(match.path) ?? [], match.lineNumber])
  const perFile = await Promise.all([...linesByPath].map(async ([path, lines]): Promise<GrepScope[]> => {
    try {
      const target = await fs.resolve(isAbsolute(path) ? path : resolve(workdir, path), { signal: exec.signal })
      const info = await fs.stat(target, exec.signal)
      if (info?.size === undefined || info.size >= maxFileBytes) return []
      const scopes = await declarationScopes(path, await fs.readText(target, exec.signal))
      if (scopes === undefined) return []
      const containing = new Set<DeclarationScope>()
      for (const line of lines) {
        const scope = innermostScope(scopes, line)
        if (scope !== undefined) containing.add(scope)
      }
      return [...containing].map(scope => ({ path, ...scope }))
    } catch {
      return []
    }
  }))
  return perFile.flat()
}

/**
 * Register the `grep` tool and its system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param caps - the deployment's resolved grep caps (plugin config after defaulting).
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: 'Use the grep tool — not shell grep or rg — to search file contents. It lists matching files by default; '
      + 'pass output "lines" only when the matching lines themselves answer the question, with context for a few lines around each match. '
      + 'Matching lines are grouped under the signature of the function, method, or class that contains them. Use read on a matched file when you need more.',
  })

  const limits: GrepArgLimits = {
    maxContextLines: caps.maxContextLines,
    maxHeadLimit: caps.maxMatches,
    defaultHeadLimit: caps.defaultHeadLimit,
  }

  const tool = defineTool({
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression. By default returns the matching files with a match count each; '
      + 'with output "lines", returns the matching lines with line numbers, grouped by file and by the declaration that contains them. '
      + `Shows ${Math.min(caps.defaultHeadLimit, caps.maxMatches)} files or matches per page unless head_limit says otherwise (at most ${caps.maxMatches}); `
      + 'use offset for the next page. A capped lines result also reports where the complete match list was saved.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
      type: { type: 'string', description: 'One ripgrep file type to search, e.g. "ts", "py", "rust". Combines with include.' },
      ignore_case: { type: 'boolean', description: 'Match case-insensitively. Defaults to false.' },
      output: { type: 'string', enum: ['files', 'lines'], description: '"files" (default): matching files with match counts. "lines": the matching lines with line numbers.' },
      context: { type: 'number', description: `Lines of context before and after each match, 0 to ${caps.maxContextLines}. Only with output "lines".` },
      before_context: { type: 'number', description: `Lines of context before each match, 0 to ${caps.maxContextLines}; overrides context. Only with output "lines".` },
      after_context: { type: 'number', description: `Lines of context after each match, 0 to ${caps.maxContextLines}; overrides context. Only with output "lines".` },
      head_limit: { type: 'number', description: `Files ("files") or matches ("lines") to show, 1 to ${caps.maxMatches}. Defaults to ${Math.min(caps.defaultHeadLimit, caps.maxMatches)}.` },
      offset: { type: 'number', description: 'Files or matches to skip, for the next page. Defaults to 0.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: { type: 'array', required: true, items: MATCH_SCHEMA },
          context: { type: 'array', items: MATCH_SCHEMA },
          scopes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                start: { type: 'integer', required: true },
                end: { type: 'integer', required: true },
                header: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderGrep(args, value) }],
      presentationMeta: (_args, value) =>
        grepSearchMeta(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args, limits)
      const page = parseGrepPage(args, limits)
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      if (run.noMatches) return { matches: [] }

      const relative = (match: GrepMatch): GrepMatch => ({ ...match, path: toWorkdirRelative(match.path, run.workdir) })
      const records = parseGrepRecords(run.stdout)
      const matches = records.matches.map(relative)
      const wantsContext = input.before !== undefined || input.after !== undefined
      const scopes = args.output === 'lines' && caps.annotateScopes
        ? await enclosingScopes(
          ctx, exec, run.workdir, records.matches.slice(page.offset, page.offset + page.limit), caps.scopeMaxFileBytes,
        )
        : []
      return {
        matches,
        ...wantsContext ? { context: records.context.map(relative) } : {},
        ...scopes.length > 0 ? { scopes: scopes.map(scope => ({ ...scope, path: toWorkdirRelative(scope.path, run.workdir) })) } : {},
      }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  /** The model-facing text of one result; `spillRef` names the saved complete result of a capped lines page. */
  function renderGrep(args: GrepArgs, value: GrepValue, spillRef?: SpillRef): string {
    const page = parseGrepPage(args, limits)
    if (args.output !== 'lines') return formatGrepFiles(value.matches, page)
    const input = parseGrepArgs(args, limits)
    return formatGrepLines(value.matches, {
      page,
      context: value.context ?? [],
      window: { before: input.before ?? 0, after: input.after ?? 0 },
      scopes: value.scopes ?? [],
      maxLineBytes: caps.maxLineBytes,
      ...spillRef !== undefined ? { spillRef } : {},
    })
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as GrepValue | undefined
    const args = exec.arguments as GrepArgs
    // Only a lines result spills; a files result pages through its files and names how to narrow them.
    if (value === undefined || args.output !== 'lines') return decision
    const matches = value.matches
    const page = parseGrepPage(args, limits)
    if (matches.length <= page.offset + page.limit) return decision
    // The spill artifact holds the COMPLETE result: preview each line, but keep
    // every match (no inline cap), so the recovery file is the full search.
    const previewedAll = matches.map(match => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }))
    const spillRef = await trySaveFormattedResult(
      ctx,
      exec,
      'grep-results.txt',
      `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(previewedAll)}`,
    )
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGrep(args, value, spillRef) }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
