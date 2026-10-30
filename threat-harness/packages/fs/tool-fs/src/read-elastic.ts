/**
 * Elastic-read decision: given a whole file's text and the model's focus (a line window or a
 * symbol), choose between the ordinary line window and a folded view that keeps the file's
 * outline visible around the focus.
 * @module @elemental/tool-fs/src/read-elastic
 */

import { listDeclarations, matchSymbol, planFolds } from './read-fold.ts'
import type { Declaration, LineSpan } from './read-fold.ts'
import { buildWindow, foldMarker, lineByteSize } from './read-render.ts'
import type { FileTextLine } from './read-render.ts'
import { grammarForPath, SUPPORTED_EXTENSIONS } from './read-syntax.ts'
import type { GrammarName, ParsedSource, SyntaxParsers } from './read-syntax.ts'

/** The most declaration names a symbol-not-found error lists. */
const LISTED_DECLARATIONS = 40

/** The model's read focus after argument validation. */
export interface ElasticRequest {
  /** 1-based first line of the requested window. */
  offset: number
  /** Lines in the requested window. */
  limit: number
  /** Whether the model passed `offset` or `limit` itself, as opposed to reading from the top by default. */
  windowed: boolean
  /** Declaration name to focus, when the model passed `symbol`. */
  symbol?: string
  /** Whether folding is allowed; `false` asks for raw lines. */
  fold: boolean
  /** Whether the model asked for the outline: every body folded, nothing in focus. */
  outline?: boolean
}

/** Read caps the elastic decision needs. */
export interface ElasticCaps {
  /** Maximum lines one read returns in full. */
  limit: number
  /** Characters kept per line before truncation. */
  maxLineLength: number
  /** Byte cap on the returned lines and fold markers. */
  maxBytes: number
  /** Whether a windowed read may fold at all; a `symbol` read folds regardless. */
  foldWindows: boolean
  /** Files shorter than this read a window as plain lines. */
  foldMinLines: number
}

/** How to serve one read. */
export type ReadPlan =
  | {
    /** Serve an ordinary line window. */
    kind: 'window'
    /** 1-based first line. */
    offset: number
    /** Lines in the window. */
    limit: number
  }
  | {
    /** Serve a folded view. */
    kind: 'elastic'
    /** Visible lines in file order; folded lines are absent. */
    lines: FileTextLine[]
    /** Exact total line count in the file. */
    totalLines: number
    /** Hidden spans, ascending. */
    folds: LineSpan[]
    /** Spans shown in full, ascending; empty for an outline. */
    focus: LineSpan[]
    /** For an outline, every named declaration with its dotted name and span, in source order. */
    declarations?: Declaration[]
  }

/**
 * Decide how to serve a read of a whole, in-memory file.
 * @param parsers - the shared tree-sitter parsers.
 * @param text - the complete file text.
 * @param displayPath - the model-facing path; its extension selects the grammar.
 * @param request - the model's validated focus.
 * @param caps - the deployment's read caps.
 * @returns a plain window, or a folded view when folding applies and fits the byte cap. An outline
 *   is always a folded view, with no folds when nothing in the file has a body to hide.
 * @throws when a `symbol` or outline read names an unsupported language, a symbol is not found,
 *   or an outline exceeds the byte cap.
 */
export async function planRead(
  parsers: SyntaxParsers,
  text: string,
  displayPath: string,
  request: ElasticRequest,
  caps: ElasticCaps,
): Promise<ReadPlan> {
  const requested: ReadPlan = { kind: 'window', offset: request.offset, limit: request.limit }
  const grammar = grammarForPath(displayPath)
  if (request.outline === true) return planOutline(parsers, text, displayPath, grammar, caps)
  if (request.symbol === undefined) {
    if (!request.fold || !request.windowed || !caps.foldWindows || grammar === undefined) return requested
  } else if (grammar === undefined) {
    throw new Error(`symbol focus is not available for "${displayPath}": it supports ${SUPPORTED_EXTENSIONS.join(', ')} files. Use offset and limit instead.`)
  }

  const all = await buildWindow(
    [text],
    { offset: 1, limit: Number.MAX_SAFE_INTEGER, maxLineLength: caps.maxLineLength, maxBytes: Number.MAX_SAFE_INTEGER },
    displayPath,
  )
  // A short file, or a window past EOF (the plain path reports the range error), reads plainly.
  if (request.symbol === undefined && (all.totalLines < caps.foldMinLines || request.offset > all.totalLines)) return requested

  let parsed: ParsedSource
  try {
    parsed = await parsers.parse(grammar, text)
  } catch (error) {
    // Folding is an optimization of a window read: without a parser it reads plainly. A symbol
    // read cannot be served without one, so the failure reaches the model.
    if (request.symbol === undefined) return requested
    throw error
  }
  try {
    let focus: [LineSpan, ...LineSpan[]]
    if (request.symbol === undefined) {
      focus = [{ start: request.offset, end: Math.min(request.offset + request.limit - 1, all.totalLines) }]
    } else {
      const declarations = listDeclarations(parsed.root)
      const [first, ...others] = matchSymbol(declarations, request.symbol)
      if (first === undefined) {
        const names = declarations.slice(0, LISTED_DECLARATIONS).map(declaration => declaration.qualifiedName)
        const more = declarations.length > LISTED_DECLARATIONS ? `, … (${declarations.length - LISTED_DECLARATIONS} more)` : ''
        const listing = names.length === 0 ? 'it declares no named symbols' : `declared symbols: ${names.join(', ')}${more}`
        throw new Error(`symbol "${request.symbol}" was not found in "${displayPath}"; ${listing}.`)
      }
      // Matches arrive in source order, so their spans are already sorted by start.
      focus = mergeSpans(first.span, others.map(match => match.span))
      const focusLines = focus.reduce((sum, span) => sum + span.end - span.start + 1, 0)
      // Raw lines were requested, or the declaration alone exceeds one read: page through it plainly.
      if (!request.fold || focusLines > caps.limit) return symbolWindow(focus[0], caps.limit)
    }

    const folds = planFolds(parsed.root, all.lines.map(line => line.text), focus)
    if (folds.length === 0) return request.symbol === undefined ? requested : symbolWindow(focus[0], caps.limit)
    const lines = all.lines.filter(line => !folds.some(fold => line.number >= fold.start && line.number <= fold.end))
    const bytes = lines.reduce((sum, line, index) => sum + lineByteSize(line.text, index), 0)
      + folds.reduce((sum, fold) => sum + lineByteSize(foldMarker(fold), 1), 0)
    if (bytes > caps.maxBytes) {
      return request.symbol === undefined ? requested : symbolWindow(focus[0], caps.limit)
    }
    return { kind: 'elastic', lines, totalLines: all.totalLines, folds, focus }
  } finally {
    parsed.dispose()
  }
}

/**
 * Plan an outline: the whole file with every function body folded, nothing in focus, and the
 * file's declarations listed for programs that pick what to read next. An outline has no plain
 * fallback, because a plain window would silently show something else: an unsupported language
 * or an outline above the byte cap is an error that says what to read instead.
 */
async function planOutline(
  parsers: SyntaxParsers,
  text: string,
  displayPath: string,
  grammar: GrammarName | undefined,
  caps: ElasticCaps,
): Promise<ReadPlan> {
  if (grammar === undefined) {
    throw new Error(`an outline is not available for "${displayPath}": it supports ${SUPPORTED_EXTENSIONS.join(', ')} files. Use offset and limit instead.`)
  }
  const all = await buildWindow(
    [text],
    { offset: 1, limit: Number.MAX_SAFE_INTEGER, maxLineLength: caps.maxLineLength, maxBytes: Number.MAX_SAFE_INTEGER },
    displayPath,
  )
  const parsed = await parsers.parse(grammar, text)
  try {
    const folds = planFolds(parsed.root, all.lines.map(line => line.text), [])
    const lines = all.lines.filter(line => !folds.some(fold => line.number >= fold.start && line.number <= fold.end))
    const bytes = lines.reduce((sum, line, index) => sum + lineByteSize(line.text, index), 0)
      + folds.reduce((sum, fold) => sum + lineByteSize(foldMarker(fold), 1), 0)
    if (bytes > caps.maxBytes) {
      throw new Error(`the outline of "${displayPath}" is ${bytes} bytes, above the ${caps.maxBytes}-byte read cap. Read a declaration with symbol, or a range with offset and limit.`)
    }
    return { kind: 'elastic', lines, totalLines: all.totalLines, folds, focus: [], declarations: listDeclarations(parsed.root) }
  } finally {
    parsed.dispose()
  }
}

/** A plain window over a focused declaration, capped at one read's lines; the footer pages through the rest. */
function symbolWindow(span: LineSpan, limit: number): ReadPlan {
  return { kind: 'window', offset: span.start, limit: Math.min(limit, span.end - span.start + 1) }
}

/** Merge spans sorted by start, joining overlapping or adjacent ones. */
function mergeSpans(first: LineSpan, rest: readonly LineSpan[]): [LineSpan, ...LineSpan[]] {
  let last = { ...first }
  const merged: [LineSpan, ...LineSpan[]] = [last]
  for (const span of rest) {
    if (span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end)
    } else {
      last = { ...span }
      merged.push(last)
    }
  }
  return merged
}
