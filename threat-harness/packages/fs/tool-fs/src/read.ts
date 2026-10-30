/**
 * Model-facing UTF-8 read. It performs one provider stat for type, routing, and observed version,
 * streams large or size-unknown files, renders a bounded window, then emits the observation. For a
 * model-direct read of an in-memory file it consults the reader's recorded knowledge first: lines
 * the reader still holds come back as a `file_unchanged` pointer, a changed file as a
 * `file_delta` of the changed hunks, and every read records what it showed.
 * @module @elemental/tool-fs/src/read
 */

import type { Context } from '@elemental/cordis'
import { defineTool } from '@elemental/tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@elemental/tools'
import type { FsReadKnowledge, FsTarget } from '@elemental/fs'
import type { ToolRunContext } from '@elemental/tools'
import { planRead } from './read-elastic.ts'
import type { ReadPlan } from './read-elastic.ts'
import type { LineSpan } from './read-fold.ts'
import type { FileTextLine } from './read-render.ts'
import { buildWindow, formatElasticOutput, formatReadOutput, langFromPath, readMetaFromMeta } from './read-render.ts'
import { evidenceVisible, formatHunks, knowledgeAfterRead, recallRead, textLines } from './read-recall.ts'
import { SyntaxParsers } from './read-syntax.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000

/**
 * Default streaming threshold (the `readStreamMinSize` config): files at or
 * above this size stream; smaller files read whole into memory.
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Default line count (the `readFoldMinLines` config) at or above which a windowed read of a source file folds. */
export const FOLD_MIN_LINES = 400

/** Resolved read-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize: number
  /** Whether an `offset`/`limit` read of a large source file returns a folded view. */
  foldWindows: boolean
  /** Files with at least this many lines fold a windowed read. */
  foldMinLines: number
}

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
  /** Whether the model passed `offset` or `limit` itself. */
  windowed: boolean
  symbol?: string
  fold: boolean
  /** Whether the model asked for the file's outline: every body folded, nothing in focus. */
  outline: boolean
}

/** Output schema of one 1-based inclusive line span (a fold or the focus of a folded view). */
const LINE_SPAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { type: 'integer', required: true },
    end: { type: 'integer', required: true },
  },
} as const

/** Output schema of one delta line: `number` is the old line for `-`, the current line otherwise. */
const DELTA_LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', required: true, enum: [' ', '-', '+'] },
    oldNumber: { type: 'integer' },
    newNumber: { type: 'integer' },
    text: { type: 'string', required: true },
  },
} as const

/** The `read` tool's structured output. */
interface ReadOutput {
  path: string
  /** 1-based first line of a plain window; 1 for a folded view, which spans the whole file. */
  offset: number
  /** Returned lines; in a folded view, every line outside `folded.folds`. */
  lines: FileTextLine[]
  totalLines: number
  /** Present exactly when the view folded: the hidden spans and the spans shown in full. */
  folded?: { folds: LineSpan[]; focus: LineSpan[] }
  /** Present exactly for an outline read: every named declaration's dotted name and line span, in source order. */
  declarations?: { name: string; start: number; end: number }[]
  /** Line limit of a plain window that a `symbol` read chose, absent when the window follows the arguments. */
  limit?: number
  /** Present when the reader already holds every requested line: no lines are returned. */
  unchanged?: { spans: LineSpan[] }
  /** Present when only the changed hunks since the reader's last read are returned. */
  delta?: {
    previousTotalLines: number
    hunks: { op: ' ' | '-' | '+'; oldNumber?: number; newNumber?: number; text: string }[][]
  }
}

/** Raw `read` tool arguments after schema validation. */
interface ReadArgs {
  file_path: string
  offset?: number
  limit?: number
  symbol?: string
  fold?: boolean
  outline?: boolean
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given,
 *   `symbol` must be non-blank and exclusive with them, and `outline` excludes `symbol`, `offset`, `limit`, and `fold: false`.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @returns the validated input with `offset` defaulted to 1, `limit` to `maxLimit`, `fold` to true, and `outline` to false.
 */
export function parseReadArgs(args: ReadArgs, maxLimit: number): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  const windowed = args.offset !== undefined || args.limit !== undefined
  const fold = args.fold ?? true
  const outline = args.outline ?? false
  if (outline) {
    if (args.symbol !== undefined || windowed) throw new Error('outline reads the whole file; do not combine it with symbol, offset, or limit')
    if (!fold) throw new Error('outline is a folded view; do not combine it with fold=false')
  }
  if (args.symbol === undefined) return { filePath: args.file_path, offset, limit, windowed, fold, outline }
  if (args.symbol.trim().length === 0) throw new Error('symbol must be a non-empty string')
  if (windowed) throw new Error('pass either symbol or offset/limit, not both')
  return { filePath: args.file_path, offset, limit, windowed, symbol: args.symbol.trim(), fold, outline }
}

/** The pointer returned when the reader already holds every requested line. */
function formatUnchanged(path: string, spans: readonly LineSpan[]): string {
  const first = spans[0]
  const last = spans.at(-1)
  /* v8 ignore next -- a pointer is only produced for a non-empty request. */
  if (first === undefined || last === undefined) return `[file_unchanged: ${path}]`
  const lines = spans.length === 1 ? `L${first.start}-L${first.end}` : `the lines you were shown between L${first.start} and L${last.end}`
  return `[file_unchanged: ${path} ${lines} are identical to your earlier read, which is still in this conversation. Use that output; nothing was re-sent.]`
}

/**
 * Register the `read` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps (plugin config after defaulting).
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps, parsers: SyntaxParsers = new SyntaxParsers()): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: 'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files. '
      + 'To work on one function, method, or class in a source file, read it by symbol: you get that declaration in full plus the file\'s imports, types, and signatures, with other bodies folded to their line spans. '
      + 'To see what a source file declares before choosing what to read, read it with outline=true.',
  })

  /** The model-facing text of one read result; execution also uses it as the result's evidence. */
  const renderText = (args: ReadArgs, value: ReadOutput): string => {
    if (value.unchanged !== undefined) return formatUnchanged(value.path, value.unchanged.spans)
    if (value.delta !== undefined) {
      return `[file_delta: ${value.path} changed since your earlier read (${value.delta.previousTotalLines} → ${value.totalLines} lines). `
        + 'Only the changed regions follow, numbered by current lines; the rest of what you read is unchanged.]\n'
        + formatHunks(value.delta.hunks)
    }
    if (value.folded !== undefined) {
      const outcome = { lines: value.lines, totalLines: value.totalLines, ...value.folded }
      return formatElasticOutput(value.path, outcome, args.symbol?.trim())
    }
    const limit = value.limit ?? parseReadArgs(args, caps.limit).limit
    const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
    const truncatedByBytes = value.lines.length < limit && endLine < value.totalLines
    return formatReadOutput(value.path, {
      offset: value.offset,
      lines: value.lines,
      totalLines: value.totalLines,
      ...truncatedByBytes ? { truncatedByBytes: true } : {},
    })
  }

  /**
   * Answer from the reader's knowledge when it can, and record what this read showed. Only a
   * model-direct call of an agent qualifies: a `run_code` sub-call returns its value to a program,
   * which needs the content itself.
   */
  const recall = async (args: ReadArgs, exec: ToolRunContext, target: FsTarget, text: string, full: ReadOutput): Promise<ReadOutput> => {
    const session = exec.parent === undefined ? exec.agent?.session : undefined
    const requested = full.lines.map(line => line.number)
    if (session === undefined || requested.length === 0) return full
    const recorded = await ctx.waterfall('fs/read-recall', target, exec, () => undefined)
    const prior = recorded !== undefined && evidenceVisible(session, recorded.evidence) ? recorded : undefined
    const record = (knowledge: FsReadKnowledge): void => { ctx.emit('fs/read-recorded', target, knowledge, exec) }
    const fullText = renderText(args, full)
    const recalled = prior === undefined ? undefined : recallRead(prior, text, requested, requested.length)
    if (recalled?.kind === 'unchanged') return { path: full.path, offset: full.offset, lines: [], totalLines: full.totalLines, unchanged: { spans: recalled.spans } }
    if (recalled?.kind === 'delta') {
      const delta: ReadOutput = {
        path: full.path,
        offset: full.offset,
        lines: [],
        totalLines: full.totalLines,
        delta: { previousTotalLines: recalled.previousTotalLines, hunks: recalled.hunks },
      }
      const deltaText = renderText(args, delta)
      if (deltaText.length < fullText.length) {
        record({ text, seen: recalled.next.seen, evidence: [...recalled.next.previous, { callId: exec.callId, text: deltaText }] })
        return delta
      }
    }
    // A line cut at the line-length cap was not shown in full, so it does not count as seen.
    const lines = textLines(text)
    const shown = full.lines.filter(line => line.text === lines[line.number - 1]).map(line => line.number)
    record(knowledgeAfterRead(prior, text, shown, { callId: exec.callId, text: fullText }))
    return full
  }

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content. '
      + `${caps.foldWindows ? `A symbol read, or an offset/limit read of a source file with ${caps.foldMinLines}+ lines,` : 'A symbol read'} returns a folded view: the requested declaration or lines in full plus the file's imports, types, and signatures, with other function bodies replaced by "⋯ [Lstart-Lend folded: n lines]" markers. `
      + 'An outline read folds every body.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
      symbol: {
        type: 'string',
        description: 'Name of a function, method, class, or other declaration to show in full, e.g. "parseArgs" or "Parser.parse"; the rest of the file is folded around it. '
          + 'Works in TypeScript, JavaScript, Python, Go, Rust, and Java files. Do not combine with offset or limit.',
      },
      fold: { type: 'boolean', description: 'Set false for raw lines with nothing folded; with symbol, returns just that declaration\'s lines. Defaults to true.' },
      outline: {
        type: 'boolean',
        description: 'Set true for the file\'s outline: imports, types, and every signature, with every function body folded. '
          + 'Use it to choose a symbol or line range to read next. Same languages as symbol; do not combine with symbol, offset, limit, or fold.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
          folded: {
            type: 'object',
            additionalProperties: false,
            properties: {
              folds: { type: 'array', required: true, items: LINE_SPAN_SCHEMA },
              focus: { type: 'array', required: true, items: LINE_SPAN_SCHEMA },
            },
          },
          limit: { type: 'integer' },
          declarations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                start: { type: 'integer', required: true },
                end: { type: 'integer', required: true },
              },
            },
          },
          unchanged: {
            type: 'object',
            additionalProperties: false,
            properties: { spans: { type: 'array', required: true, items: LINE_SPAN_SCHEMA } },
          },
          delta: {
            type: 'object',
            additionalProperties: false,
            properties: {
              previousTotalLines: { type: 'integer', required: true },
              hunks: { type: 'array', required: true, items: { type: 'array', items: DELTA_LINE_SCHEMA } },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderText(args, value) }],
      // Project the structured window into persisted `meta` so a UI's read card
      // survives replay: the raw canonical output object is not on the wire, only
      // the model-facing text, from which the line/lang data cannot be recovered.
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(({ number, text }) => ({ number, text })),
          totalLines: value.totalLines,
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    // Observation races fail closed because guarded mutations re-check the version in-lock.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      // One stat: absence observation OR type check + size routing + present version.
      // A concurrent write can only make a later guarded mutation fail stale and require reread.
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)

      // Stream when the file is large OR size is unknown, so a size-less backend
      // never buffers an arbitrarily large file. Folding needs the whole text, so only
      // in-memory files fold.
      const streamed = info.size === undefined || info.size >= caps.streamMinSize
      if (streamed && (input.symbol !== undefined || input.outline)) {
        throw new Error(`${input.outline ? 'an outline' : 'symbol focus'} needs the whole file in memory, and "${target.displayPath}" is ${info.size === undefined ? 'of unknown size' : `${info.size} bytes`}. Use offset and limit instead.`)
      }
      let chunks: AsyncIterable<string> | Iterable<string>
      let text: string | undefined
      let plan: ReadPlan = { kind: 'window', offset: input.offset, limit: input.limit }
      if (streamed) {
        chunks = await ctx.fs.streamText(target, exec.signal)
      } else {
        text = await ctx.fs.readText(target, exec.signal)
        chunks = [text]
        plan = await planRead(parsers, text, target.displayPath, input, caps)
      }

      let outcome: ReadOutput
      if (plan.kind === 'elastic') {
        outcome = {
          path: target.displayPath,
          offset: 1,
          lines: plan.lines,
          totalLines: plan.totalLines,
          folded: { folds: plan.folds, focus: plan.focus },
          ...plan.declarations === undefined
            ? {}
            : {
              declarations: plan.declarations.map(({ qualifiedName, span }) => ({ name: qualifiedName, start: span.start, end: span.end })),
            },
        }
      } else {
        const window = await buildWindow(
          chunks,
          { offset: plan.offset, limit: plan.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
          target.displayPath,
        )
        outcome = {
          path: target.displayPath,
          offset: plan.offset,
          lines: window.lines,
          totalLines: window.totalLines,
          ...input.symbol === undefined ? {} : { limit: plan.limit },
        }
      }
      // Streamed files are never held whole, so they are neither recalled nor recorded.
      if (text !== undefined) outcome = await recall(args, exec, target, text, outcome)
      // Record the present observation (a no-op when no policy plugin listens). The
      // read already succeeded; an fs/observed listener is contractually a
      // synchronous, side-effect-only recorder.
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // Result-time display: a `read` card carrying the structured line window a
    // capable UI renders as a line-numbered, syntax-highlighted view. The
    // structured data is narrowed from the persisted `meta` (replay-safe); the
    // envelope-stripped model-facing text rides along as `content` so a UI without
    // the read capability still shows the file text. A malformed or absent meta,
    // or a result whose text is not the read envelope, declines to `undefined`
    // (the generic fallback), never throwing on replay of obsolete logged output.
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // Group 1 always captures (possibly empty) when the envelope matches.
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    // Pure display: a generic card titled by the file with the read window or symbol appended
    // (`Read foo.txt (5 - 8)`, `Read foo.ts (parseArgs)`, `Read foo.ts (outline)`), `read` kind (icon), and a
    // follow-along location whose line is the
    // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
    // the title bare instead of smuggling config into this pure presenter.
    presentCall(args): GenericCallView {
      const { offset, limit, symbol } = args
      let window = ''
      if (args.outline === true) window = ' (outline)'
      else if (symbol !== undefined) window = ` (${symbol})`
      else if (limit !== undefined && limit > 0) window = ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
      else if (offset !== undefined) window = ` (from line ${offset})`
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}
