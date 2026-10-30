/**
 * Codex as a comparison agent for the file-finding evaluation.
 *
 * Runs `codex exec --json` against an OpenAI Responses-compatible provider and
 * converts the run's rollout file (one JSON row per model output, tool call,
 * tool result, and per-response token count) into the same session-event shape
 * the harness driver streams, so one metrics function scores every agent.
 */

import type { EvalEvent, EvalUsage } from './metrics.ts'

/** An OpenAI Responses-compatible endpoint Codex is pointed at instead of its own login. */
export interface CodexProvider {
  readonly baseURL: string
  readonly apiKey: string
}

/** Environment variable the run's provider reads its key from. */
export const CODEX_KEY_ENV = 'ELEMENTAL_EVAL_CODEX_KEY'

/**
 * Command-line arguments for one headless Codex run.
 * Approvals and the sandbox are off, as for Claude Code: the run is confined
 * only by its working directory being a throwaway workspace. Web search is
 * off because no task needs it, and a Gemini-backed gateway answers a request
 * carrying the built-in `web_search` tool with search alone, dropping the shell.
 * @param prompt - the task prompt, identical to the other agents'.
 * @param provider - the endpoint the run talks to.
 * @param model - the provider's model id.
 * @param catalogPath - model catalog naming `model`, from {@link codexModelCatalog}.
 * @returns the arguments after the `codex` executable.
 */
export function codexArgs(prompt: string, provider: CodexProvider, model: string, catalogPath: string): string[] {
  return [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-c', 'model_provider="eval"',
    '-c', `model=${tomlString(model)}`,
    '-c', `model_catalog_json=${tomlString(catalogPath)}`,
    '-c', 'web_search="disabled"',
    '-c', `model_providers.eval={ name = "eval", base_url = ${tomlString(provider.baseURL)}, env_key = "${CODEX_KEY_ENV}", wire_api = "responses" }`,
    prompt,
  ]
}

/**
 * Environment for a Codex run: a fresh home, so the user's config, plugins,
 * memories, and global AGENTS.md stay out of the result, and the provider key.
 * @param base - the environment to start from, usually `process.env`.
 * @param provider - the endpoint and key to use.
 * @param home - an empty directory for `CODEX_HOME`, outside the system temp
 *   directory, where Codex refuses to install its `apply_patch` helper.
 * @returns a new environment; `base` is not changed.
 */
export function codexEnv(base: NodeJS.ProcessEnv, provider: CodexProvider, home: string): NodeJS.ProcessEnv {
  return { ...base, CODEX_HOME: home, [CODEX_KEY_ENV]: provider.apiKey }
}

/** The fields of a Codex model-catalog entry this module reads or overrides. */
interface CatalogModel {
  readonly slug: string
  readonly apply_patch_tool_type?: string
  readonly model_messages?: unknown
  readonly [field: string]: unknown
}

/**
 * A one-model catalog that gives a provider's model Codex's own tool setup.
 * Codex has no metadata for a gateway model and would otherwise fall back to a
 * reduced tool set without `apply_patch`. The entry copies the installed
 * Codex's first catalog model that edits through freeform `apply_patch`, minus
 * what only OpenAI's servers support (code mode, Responses lite, hosted search)
 * and minus a default reasoning effort and verbosity, which the other agents
 * do not send either.
 * @param cache - the installed Codex's `models_cache.json`, parsed.
 * @param model - the provider's model id.
 * @returns the catalog, and the slug of the model whose setup it copies.
 */
export function codexModelCatalog(cache: unknown, model: string): { catalog: { models: CatalogModel[] }; basedOn: string } {
  const models = (cache as { models?: unknown } | undefined)?.models
  const base = Array.isArray(models)
    ? (models as CatalogModel[]).find(entry => entry.apply_patch_tool_type === 'freeform' && entry.model_messages !== undefined)
    : undefined
  if (base === undefined) throw new Error('the Codex model cache has no model with freeform apply_patch and a prompt template')
  const {
    tool_mode: _toolMode,
    availability_nux: _nux,
    upgrade: _upgrade,
    default_reasoning_level: _effort,
    default_verbosity: _verbosity,
    ...kept
  } = base
  return {
    basedOn: base.slug,
    catalog: {
      models: [{
        ...kept,
        slug: model,
        display_name: model,
        priority: 0,
        supported_reasoning_levels: [],
        supports_reasoning_effort_updates: false,
        support_verbosity: false,
        use_responses_lite: false,
        supports_search_tool: false,
        experimental_supported_tools: [],
      }],
    },
  }
}

interface RolloutRow {
  readonly type?: string
  readonly payload?: {
    readonly type?: string
    readonly role?: string
    readonly name?: string
    readonly arguments?: string
    readonly input?: string
    readonly output?: unknown
    readonly message?: string
    readonly last_agent_message?: string | null
    readonly info?: { readonly total_token_usage?: CodexUsage } | null
  }
}

interface CodexUsage {
  /** All input, cached included, as OpenAI reports it. */
  readonly input_tokens?: number
  readonly cached_input_tokens?: number
  readonly cache_write_input_tokens?: number
  readonly output_tokens?: number
}

/** Rollout item types the model produces; anything else is context or a tool result. */
const MODEL_OUTPUT = new Set(['message', 'reasoning', 'function_call', 'custom_tool_call', 'local_shell_call'])
const SHELL_CALLS = new Set(['exec_command', 'shell', 'shell_command', 'local_shell'])

/**
 * Parse one Codex run.
 * A step is one model response: it begins at the first model output after the
 * previous response's token count. Shell calls become `shell` tool calls with a
 * `command` argument, and each file an `apply_patch` touches becomes an `edit`.
 * @param stdout - `codex exec --json` stdout: the thread id and any failure.
 * @param rollout - the main thread's rollout file, or undefined when Codex never wrote one.
 * @returns harness-shaped events, total usage, the final text, and the error text of a failed run.
 */
export function parseCodexRun(stdout: string, rollout: string | undefined): {
  events: EvalEvent[]
  usage?: EvalUsage
  output?: string
  error?: string
} {
  const events: EvalEvent[] = []
  let steps = 0
  let inStep = false
  let usage: EvalUsage | undefined
  let output: string | undefined
  let error: string | undefined

  for (const row of jsonLines<RolloutRow>(rollout ?? '')) {
    const payload = row.payload
    if (payload === undefined) continue
    if (row.type === 'response_item') {
      // The prompt, instructions, and environment context are messages too, but not the model's.
      const modelOutput = MODEL_OUTPUT.has(payload.type ?? '') && (payload.type !== 'message' || payload.role === 'assistant')
      if (modelOutput && !inStep) {
        inStep = true
        steps += 1
        events.push({ type: 'step/start', data: { step: steps } })
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        events.push(...toolCalls(payload.name ?? '', payload.type === 'custom_tool_call' ? payload.input : payload.arguments))
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        events.push({ type: 'tool/result', data: { message: { content: [{ content: payload.output }] } } })
      }
    } else if (row.type === 'event_msg') {
      if (payload.type === 'token_count') {
        inStep = false
        const total = payload.info?.total_token_usage
        if (total !== undefined) usage = toEvalUsage(total)
      } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
        output = payload.last_agent_message
      } else if (payload.type === 'error' && payload.message !== undefined) {
        error = payload.message
      }
    }
  }

  for (const row of jsonLines<{ type?: string; message?: string; error?: { message?: string } }>(stdout)) {
    if (row.type === 'turn.failed') error = row.error?.message ?? error ?? 'Codex reported a failed turn'
    else if (row.type === 'error' && row.message !== undefined) error ??= row.message
  }
  return {
    events,
    ...usage === undefined ? {} : { usage },
    ...output === undefined ? {} : { output },
    ...error === undefined ? {} : { error },
  }
}

/**
 * The thread id `codex exec --json` announces first, which names the main
 * thread's rollout file (subagents write their own).
 * @param stdout - the run's stdout.
 * @returns the id, or undefined when Codex never started a thread.
 */
export function codexThreadId(stdout: string): string | undefined {
  for (const row of jsonLines<{ type?: string; thread_id?: string }>(stdout)) {
    if (row.type === 'thread.started' && row.thread_id !== undefined) return row.thread_id
  }
  return undefined
}

function toolCalls(name: string, raw: string | undefined): EvalEvent[] {
  if (name === 'apply_patch') {
    // A function-style apply_patch wraps the patch as `{"input": …}`.
    const patch = (parseJson(raw ?? '') as { input?: string } | undefined)?.input ?? raw ?? ''
    return patchedFiles(patch).map(path => ({ type: 'tool/call', data: { name: 'edit', arguments: { path } } }))
  }
  if (SHELL_CALLS.has(name)) {
    const args = parseJson(raw ?? '') as { cmd?: unknown; command?: unknown } | undefined
    const command = args?.cmd ?? args?.command
    const text = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : ''
    // Codex also takes a patch through the shell (`apply_patch <<'EOF' …`).
    const edits = patchedFiles(text).map(path => ({ type: 'tool/call', data: { name: 'edit', arguments: { path } } }))
    return [{ type: 'tool/call', data: { name: 'shell', arguments: { command: text } } }, ...edits]
  }
  return [{ type: 'tool/call', data: { name, arguments: parseJson(raw ?? '') ?? raw } }]
}

/**
 * Files a Codex patch adds, updates, deletes, or moves to.
 * @param patch - patch text in Codex's `*** Begin Patch` format.
 * @returns the paths, in patch order.
 */
export function patchedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
    .map(match => (match[1] ?? match[2] ?? '').trim())
    .filter(path => path.length > 0)
}

function toEvalUsage(raw: CodexUsage): EvalUsage {
  const cached = raw.cached_input_tokens ?? 0
  const written = raw.cache_write_input_tokens ?? 0
  return {
    inputTokens: Math.max(0, (raw.input_tokens ?? 0) - cached - written),
    outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  }
}

/** A TOML literal string, which keeps Windows backslashes as they are. */
function tomlString(value: string): string {
  if (/['\n]/.test(value)) throw new Error(`cannot pass ${JSON.stringify(value)} to codex -c as a literal string`)
  return `'${value}'`
}

function* jsonLines<T>(text: string): Generator<T> {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    const row = parseJson(line) as T | undefined
    if (row !== undefined) yield row
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
