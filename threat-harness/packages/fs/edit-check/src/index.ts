/**
 * The edit-check PLUGIN: after an accepted model-direct `edit` or `write`, run the deployment's
 * configured checker for the file's extension (a linter or type checker that answers in well
 * under a second) within a strict deadline, and append the diagnostics the change introduced to
 * the tool result. The model then fixes them on its next step instead of finding them in a build
 * several edits later.
 *
 * Checkers are configured, never chosen by the model, and run through `ctx.subprocess` like other
 * deployment-owned commands. A checker that reads stdin is run on the text before and after the
 * change, so only new diagnostics are reported. A checker that reads the file on disk runs once,
 * after the change, and is compared with its previous result for the same file.
 *
 * Best-effort throughout: a missing executable, a deadline, an abort, or unparsable output adds
 * nothing to the result, and the edit that already landed is never turned into an error.
 *
 * @module @elemental/edit-check
 */

import type { Context } from '@elemental/cordis'
import z from '@elemental/schemastery'
import { extname, isAbsolute, resolve } from 'node:path'
import type { ContentBlock } from '@elemental/llm'
import type { SubprocessSpawnSpec } from '@elemental/subprocess'
import type { PostToolDecision, ToolExecution } from '@elemental/tools'
import { formatDiagnosticNotice, introducedDiagnostics, parseDiagnostics } from './diagnostics.ts'
import type { Diagnostic } from './diagnostics.ts'

export { formatDiagnosticNotice, introducedDiagnostics, parseDiagnostics } from './diagnostics.ts'
export type { Diagnostic } from './diagnostics.ts'

/** One configured checker. */
export interface CheckerSpec {
  /** File extensions it checks, with the dot, e.g. `['.py', '.pyi']`. Matched case-insensitively. */
  extensions: string[]
  /** Executable: an absolute path or a bare name looked up on the subprocess runtime's PATH. */
  command: string
  /** Arguments; every `{path}` is replaced with the checked file's absolute path. */
  args: string[]
  /**
   * `true` feeds the file's text on stdin and checks the text before and after the change, so
   * only new diagnostics are reported. `false` (the default) lets the checker read the file
   * on disk after the change and compares with its previous result for the same file.
   */
  stdin?: boolean
}

/** Plugin config. */
export interface Config {
  /** Checkers by name; the name appears in the notice. Omitted or empty registers nothing. */
  checkers?: Record<string, CheckerSpec>
  /** Wall-clock budget for one check, both runs of a stdin checker included, in milliseconds. */
  timeoutMs?: number
  /** How many diagnostics a notice lists before counting the rest. */
  maxListed?: number
  /** Bytes of stdout and of stderr kept from one checker run; output past this is not parsed. */
  maxOutputBytes?: number
  /** Milliseconds a timed-out checker gets to exit after termination before it is killed. */
  graceMs?: number
  /** Tools whose results are checked. Each must return the `{ path, before, after }` value of `edit` and `write`. */
  tools?: string[]
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edit-check'

/** The tool registry's post-execute waterfall carries the results; checkers run through `ctx.subprocess`. */
export const inject = ['tools', 'subprocess']

/** Default `timeoutMs`: the design budget for a check that must not slow the edit loop. */
const DEFAULT_TIMEOUT_MS = 500

export const Config: z<Config> = z.object({
  checkers: z.dict(z.object({
    extensions: z.array(z.string()).required(),
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    stdin: z.boolean().default(false),
  })),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS),
  maxListed: z.natural().default(3),
  maxOutputBytes: z.natural().default(65_536),
  graceMs: z.natural().default(100),
  tools: z.array(z.string()).default(['edit', 'write']),
})

/** The value `edit` and `write` return; other shapes are not checked. */
interface ChangedFile {
  path: string
  before: string | null
  after: string
}

/** Minimal structural view of the owning session: its working directory, when it has one. */
interface EditCheckExec {
  agent?: { session: { header: { cwd?: string } } }
}

function changedFile(value: unknown): ChangedFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { path, before, after } = value as Record<string, unknown>
  if (typeof path !== 'string' || typeof after !== 'string') return undefined
  return { path, before: typeof before === 'string' ? before : null, after }
}

/** The result content with the notice on its own line after the final text, or as a new block after a non-text one. */
function withNotice(content: readonly ContentBlock[], notice: string): ContentBlock[] {
  const last = content.at(-1)
  if (last?.type === 'text') return [...content.slice(0, -1), { type: 'text', text: `${last.text}\n${notice}` }]
  return [...content, { type: 'text', text: notice }]
}

function assertPositive(field: string, value: number): void {
  if (value < 1) throw new Error(`edit-check: ${field} must be a positive integer (got ${value})`)
}

export function apply(ctx: Context, config: Config): void {
  // schemastery has filled every defaulted field.
  const resolved = config as Required<Config>
  const entries = Object.entries(config.checkers ?? {}) as [string, Required<CheckerSpec>][]
  if (entries.length === 0) return
  assertPositive('timeoutMs', resolved.timeoutMs)
  assertPositive('maxListed', resolved.maxListed)
  assertPositive('maxOutputBytes', resolved.maxOutputBytes)
  const byExtension = new Map<string, [string, Required<CheckerSpec>]>()
  for (const [checker, spec] of entries) {
    if (spec.extensions.length === 0) throw new Error(`edit-check: checkers.${checker}.extensions must list at least one extension`)
    for (const extension of spec.extensions) {
      if (!extension.startsWith('.')) throw new Error(`edit-check: checkers.${checker}.extensions must start with a dot (got "${extension}")`)
      const key = extension.toLowerCase()
      const taken = byExtension.get(key)
      if (taken !== undefined) throw new Error(`edit-check: ${extension} is claimed by both ${taken[0]} and ${checker}`)
      byExtension.set(key, [checker, spec])
    }
  }
  const tools = new Set(resolved.tools)
  // A checker's executable is resolved once; a failure disables that checker with one warning.
  const executables = new Map<string, Promise<string | undefined>>()
  const executable = (checker: string, command: string): Promise<string | undefined> => {
    let found = executables.get(checker)
    if (found === undefined) {
      found = ctx.subprocess.resolveExecutable(command).catch((error: unknown) => {
        ctx.logger.warn(`edit-check: ${checker} is disabled: cannot resolve "${command}": ${String(error)}`)
        return undefined
      })
      executables.set(checker, found)
    }
    return found
  }
  // The last diagnostics per file for checkers that read the file on disk: their baseline.
  const previous = new Map<string, Diagnostic[]>()

  /** One checker run: its combined output, or `undefined` when it timed out, was aborted, or could not start. */
  async function run(argv: readonly string[], cwd: string, stdin: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: stdin === undefined ? 'ignore' : { data: stdin },
          stdout: { maxBytes: resolved.maxOutputBytes },
          stderr: { maxBytes: resolved.maxOutputBytes },
        },
        graceMs: resolved.graceMs,
        signal,
      } satisfies SubprocessSpawnSpec)
      const outcome = await handle.done
      if (signal.aborted || outcome.signal !== null) return undefined
      // Both streams were requested as collected, so both readers exist.
      /* v8 ignore next 2 -- a collected stream always has a reader. */
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return `${stdout}\n${stderr}`
    } catch (error: unknown) {
      ctx.logger.debug(`edit-check: checker run failed: ${String(error)}`)
      return undefined
    }
  }

  /** The notice for one changed file, or `undefined` when there is nothing to report. */
  async function check(exec: ToolExecution, file: ChangedFile): Promise<string | undefined> {
    const match = byExtension.get(extname(file.path).toLowerCase())
    if (match === undefined) return undefined
    const [checker, spec] = match
    const command = await executable(checker, spec.command)
    if (command === undefined) return undefined
    const cwd = (exec as EditCheckExec).agent?.session.header.cwd ?? process.cwd()
    const path = isAbsolute(file.path) ? file.path : resolve(cwd, file.path)
    const argv = [command, ...spec.args.map(arg => arg.replaceAll('{path}', path))]
    const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(resolved.timeoutMs)])
    if (spec.stdin) {
      const [before, after] = await Promise.all([
        file.before === null ? Promise.resolve('') : run(argv, cwd, file.before, signal),
        run(argv, cwd, file.after, signal),
      ])
      if (before === undefined || after === undefined) return undefined
      const introduced = introducedDiagnostics(parseDiagnostics(before, path, cwd), parseDiagnostics(after, path, cwd))
      return introduced.length === 0 ? undefined : formatDiagnosticNotice(checker, introduced, true, resolved.maxListed)
    }
    const output = await run(argv, cwd, undefined, signal)
    if (output === undefined) return undefined
    const diagnostics = parseDiagnostics(output, path, cwd)
    const baseline = previous.get(path)
    previous.set(path, diagnostics)
    // A new file has no earlier diagnostics; an existing file seen for the first time has an unknown baseline.
    const known = baseline ?? (file.before === null ? [] : undefined)
    const reported = known === undefined ? diagnostics : introducedDiagnostics(known, diagnostics)
    return reported.length === 0 ? undefined : formatDiagnosticNotice(checker, reported, known !== undefined, resolved.maxListed)
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    // Only accepted, model-direct results of the checked tools: a run_code program receives the
    // value, never this projection, and a value replacement owns the rendering.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || result.isError
      || exec.parent !== undefined || !tools.has(exec.name)) return decision
    const file = changedFile(result.value)
    if (file === undefined) return decision
    const notice = await check(exec, file)
    if (notice === undefined) return decision
    const content = withNotice(decision.content ?? result.content, notice)
    return { kind: 'accept', content, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  })
}
