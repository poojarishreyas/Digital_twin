/**
 * Claude Code as a comparison agent for the file-finding evaluation.
 *
 * Converts `claude -p --output-format stream-json --verbose` output into the
 * same session-event shape the harness driver streams, so one metrics
 * function scores both agents on the same tasks.
 */

import type { EvalEvent, EvalUsage } from './metrics.ts'

/** Claude Code tool names mapped onto the harness tools the metrics recognize. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Grep: 'grep',
  Glob: 'glob',
  Bash: 'bash',
  PowerShell: 'pwsh',
}

/**
 * Command-line arguments for one headless Claude Code run.
 * Only project settings load and no MCP servers, so the user's hooks,
 * plugins, and servers do not change the result; there is no sandbox, so the
 * run is confined only by its working directory being a throwaway workspace.
 * @param prompt - the task prompt, identical to the harness agent's.
 * @param model - model alias or id; Claude Code's default when undefined.
 * @returns the arguments after the `claude` executable.
 */
export function claudeCodeArgs(prompt: string, model?: string): string[] {
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    ...model === undefined ? [] : ['--model', model],
  ]
}

/** An Anthropic-compatible endpoint Claude Code is pointed at instead of its own login. */
export interface ClaudeCodeProvider {
  /** Base URL; a trailing `/v1` is dropped because Claude Code appends `/v1/messages`. */
  readonly baseURL: string
  readonly apiKey: string
}

/**
 * Environment for a Claude Code run against another provider.
 * Every model tier and subagents are pinned to one model, so a comparison is
 * not skewed by Claude Code moving side work to a smaller model.
 * @param base - the environment to start from, usually `process.env`.
 * @param provider - the endpoint and key to use.
 * @param model - the provider's model id.
 * @returns a new environment; `base` is not changed.
 */
export function claudeCodeEnv(base: NodeJS.ProcessEnv, provider: ClaudeCodeProvider, model: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ANTHROPIC_BASE_URL: provider.baseURL.replace(/\/v1\/?$/, ''),
    ANTHROPIC_AUTH_TOKEN: provider.apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  // An API key outranks the auth token and would send the run to Anthropic.
  delete env.ANTHROPIC_API_KEY
  return env
}

interface StreamRow {
  readonly type?: string
  readonly parent_tool_use_id?: string | null
  readonly message?: { readonly id?: string; readonly model?: string; readonly content?: unknown }
  readonly result?: string
  readonly is_error?: boolean
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }
}

interface ContentBlock {
  readonly type?: string
  readonly name?: string
  readonly input?: unknown
  readonly content?: unknown
}

/**
 * Parse Claude Code's stream-json stdout.
 * A step is one main-thread model response (one message id); tool calls from
 * subagents count toward tool activity but not steps.
 * @param stdout - the run's stdout, one JSON object per line.
 * @returns harness-shaped events, total usage, the final text, the error text of a failed run,
 *   and the model the endpoint says answered, which shows whether a run really used the model asked for.
 */
export function parseClaudeCodeOutput(stdout: string): {
  events: EvalEvent[]
  usage?: EvalUsage
  output?: string
  error?: string
  model?: string
} {
  const events: EvalEvent[] = []
  const steps = new Set<string>()
  let usage: EvalUsage | undefined
  let output: string | undefined
  let error: string | undefined
  let model: string | undefined
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: StreamRow
    try {
      row = JSON.parse(line) as StreamRow
    } catch {
      continue
    }
    const blocks = Array.isArray(row.message?.content) ? row.message.content as ContentBlock[] : []
    if (row.type === 'assistant') {
      model ??= row.message?.model
      const id = row.message?.id
      if (id !== undefined && (row.parent_tool_use_id ?? null) === null && !steps.has(id)) {
        steps.add(id)
        events.push({ type: 'step/start', data: { step: steps.size } })
      }
      for (const block of blocks) {
        if (block.type !== 'tool_use' || block.name === undefined) continue
        events.push({ type: 'tool/call', data: { name: TOOL_NAMES[block.name] ?? block.name, arguments: block.input } })
      }
    } else if (row.type === 'user') {
      for (const block of blocks) {
        if (block.type === 'tool_result') events.push({ type: 'tool/result', data: { message: { content: [{ content: block.content }] } } })
      }
    } else if (row.type === 'result') {
      output = row.result
      if (row.is_error === true) error = row.result ?? 'Claude Code reported an error'
      const raw = row.usage
      if (raw !== undefined) {
        usage = {
          inputTokens: raw.input_tokens ?? 0,
          outputTokens: raw.output_tokens ?? 0,
          cacheReadTokens: raw.cache_read_input_tokens ?? 0,
          cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
        }
      }
    }
  }
  return {
    events,
    ...usage === undefined ? {} : { usage },
    ...output === undefined ? {} : { output },
    ...error === undefined ? {} : { error },
    ...model === undefined ? {} : { model },
  }
}
