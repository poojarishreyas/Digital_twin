/**
 * Model-facing read, read_image, write, and edit tools over `ctx.fs`. This package owns schemas, validation,
 * read windows, formatting, and observation events, never a concrete provider. An optional
 * event policy supplies mutation guards; without one the tools use unconditional provider calls.
 * @module @elemental/tool-fs
 */

import type { Context } from '@elemental/cordis'
import z from '@elemental/schemastery'
import type { } from '@elemental/user-approval'
import type { } from '@elemental/compaction-tool-result-pruner'
import { applyReadTool, FOLD_MIN_LINES, READ_LIMIT, STREAM_MIN_SIZE } from './read.ts'
import { applyWriteTool } from './write.ts'
import { applyEditTool } from './edit.ts'
import { applyReadImageTool } from './read-image.ts'
import { READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.ts'
import { FsSandboxController } from './sandbox.ts'
import { readSuperseded } from './supersession.ts'
import { SyntaxParsers } from './read-syntax.ts'

/** Default `editSyntaxMaxListed`: enough to show a cascade's first errors without listing every one. */
const EDIT_SYNTAX_MAX_LISTED = 3

export { declarationScopes, innermostScope } from './scopes.ts'
export type { DeclarationScope } from './scopes.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs'

/** Services required by the filesystem tool suite. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Default and maximum number of lines returned by one `read` call. */
  readLimit?: number
  /** Maximum characters returned for a single line before truncation. */
  readMaxLineLength?: number
  /** Maximum bytes returned for the selected lines of one `read` call. */
  readMaxBytes?: number
  /** Files at or above this size stream instead of loading whole into memory. */
  readStreamMinSize?: number
  /** Whether an `offset`/`limit` read of a large source file returns a folded view; `symbol` reads fold regardless. */
  readFoldWindows?: boolean
  /** Line count at or above which an `offset`/`limit` read of a source file folds. */
  readFoldMinLines?: number
  /** Whether `edit` and `write` parse the changed file and report the syntax errors the change introduced. */
  editSyntaxCheck?: boolean
  /** How many introduced syntax errors one `edit` or `write` result lists before summarizing the rest. */
  editSyntaxMaxListed?: number
}

export const Config: z<Config> = z.object({
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
  readStreamMinSize: z.number().default(STREAM_MIN_SIZE),
  readFoldWindows: z.boolean().default(true),
  readFoldMinLines: z.number().default(FOLD_MIN_LINES),
  editSyntaxCheck: z.boolean().default(true),
  editSyntaxMaxListed: z.number().default(EDIT_SYNTAX_MAX_LISTED),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every read cap counts lines/chars/bytes — a positive integer, or windowing arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs: ${name} must be a positive integer`)
  }
}

/** Register the full `read`/`write`/`edit` filesystem tool suite, plus `read_image` while `attachments` is mounted. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('readLimit', resolved.readLimit)
  assertPositiveInteger('readMaxLineLength', resolved.readMaxLineLength)
  assertPositiveInteger('readMaxBytes', resolved.readMaxBytes)
  assertPositiveInteger('readStreamMinSize', resolved.readStreamMinSize)
  assertPositiveInteger('readFoldMinLines', resolved.readFoldMinLines)
  assertPositiveInteger('editSyntaxMaxListed', resolved.editSyntaxMaxListed)
  // One set of grammars serves folded reads and the edit/write syntax check.
  const parsers = new SyntaxParsers()
  applyReadTool(ctx, {
    limit: resolved.readLimit,
    maxLineLength: resolved.readMaxLineLength,
    maxBytes: resolved.readMaxBytes,
    streamMinSize: resolved.readStreamMinSize,
    foldWindows: resolved.readFoldWindows,
    foldMinLines: resolved.readFoldMinLines,
  }, parsers)
  // read_image is composition-conditional: without a mounted attachment store
  // the deployment cannot durably commit image bytes, so the tool never
  // registers; the execute body keeps a defensive re-check for direct callers.
  ctx.inject(['attachments'], (imageCtx) => {
    applyReadImageTool(imageCtx)
  })
  // With the tool-result pruner mounted, a read result that a later full re-read or a whole-file
  // write replaced collapses to a superseded marker at the next fold.
  ctx.inject(['toolResultPruner'], (pruneCtx) => {
    pruneCtx.effect(() => pruneCtx.toolResultPruner.registerSupersession('read', readSuperseded), 'read supersession rule')
  })
  // One escalation API shared by both mutating tools: advertisement gating,
  // per-call policy resolution, and denial-marker mapping, all keyed off whether
  // the mounted ctx.fs confines (ctx.fs.sandboxMode).
  const sandbox = new FsSandboxController(ctx)
  // A file large enough to stream on read is not parsed after a change either.
  const syntax = {
    enabled: resolved.editSyntaxCheck,
    parsers,
    maxBytes: resolved.readStreamMinSize,
    maxListed: resolved.editSyntaxMaxListed,
  }
  applyWriteTool(ctx, sandbox, syntax)
  applyEditTool(ctx, sandbox, {
    maxEdits: resolved.readLimit,
    maxBytes: resolved.readMaxBytes,
    streamMinSize: resolved.readStreamMinSize,
  }, syntax)
}
