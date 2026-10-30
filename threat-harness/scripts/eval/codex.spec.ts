import { describe, expect, it } from 'vitest'
import { codexArgs, codexEnv, codexModelCatalog, codexThreadId, parseCodexRun, patchedFiles } from './codex.ts'
import { computeMetrics } from './metrics.ts'

const WORKSPACE = '/w'
const SOURCE = 'packages/a/b/src/a.ts'
const PROVIDER = { baseURL: 'http://localhost:20128/v1', apiKey: 'sk-test' }

// Rows shaped like a real Codex 0.153 rollout: context messages first, then per
// response its outputs, the tool results, and a cumulative token count.
const item = (payload: Record<string, unknown>): unknown => ({ type: 'response_item', payload })
const tokens = (input: number, cached: number, output: number): unknown =>
  ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
const lines = (rows: readonly unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n')

describe('parseCodexRun', () => {
  it('counts one step per model response and maps shell and patch calls onto harness tools', () => {
    const rollout = lines([
      { type: 'session_meta', payload: { id: 't1' } },
      item({ type: 'message', role: 'developer', content: [] }),
      item({ type: 'message', role: 'user', content: [] }),
      item({ type: 'reasoning', summary: [] }),
      item({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n "x =" packages' }) }),
      item({ type: 'function_call_output', output: `${SOURCE}:1:export const x = 1` }),
      tokens(1_000, 0, 50),
      item({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `Get-Content ${SOURCE}` }) }),
      item({ type: 'function_call_output', output: 'export const x = 1' }),
      tokens(2_500, 400, 90),
      item({ type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${WORKSPACE}/${SOURCE}\n@@\n-export const x = 1\n+export const x = 2\n*** End Patch` }),
      item({ type: 'custom_tool_call_output', output: 'Success' }),
      tokens(4_200, 1_000, 130),
      item({ type: 'message', role: 'assistant', content: [] }),
      tokens(6_000, 2_000, 160),
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'fixed' } },
    ])
    const parsed = parseCodexRun('{"type":"thread.started","thread_id":"t1"}', rollout)

    expect(parsed.usage).toEqual({ inputTokens: 4_000, outputTokens: 160, cacheReadTokens: 2_000, cacheWriteTokens: 0 })
    expect(parsed.output).toBe('fixed')
    expect(parsed.error).toBeUndefined()
    const metrics = computeMetrics(parsed.events, { workspace: WORKSPACE, sourceFiles: [SOURCE], testFiles: [] }, parsed.usage)
    expect(metrics.steps).toBe(4)
    expect(metrics.toolCalls).toEqual({ shell: 2, edit: 1 })
    expect(metrics.firstSeenStep).toBe(1)
    expect(metrics.firstReadStep).toBe(2)
    expect(metrics.editedFiles).toEqual([SOURCE])
  })

  it('reports a failed turn from stdout, even without a rollout', () => {
    const stdout = lines([
      { type: 'thread.started', thread_id: 't2' },
      { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
    ])
    expect(parseCodexRun(stdout, undefined)).toEqual({ events: [], error: 'stream disconnected before completion' })
    expect(codexThreadId(stdout)).toBe('t2')
  })

  it('counts a patch sent through the shell as an edit', () => {
    const rollout = lines([
      item({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${SOURCE}\n+x\n*** End Patch\nEOF` }) }),
    ])
    const metrics = computeMetrics(parseCodexRun('', rollout).events, { workspace: WORKSPACE, sourceFiles: [SOURCE], testFiles: [] })
    expect(metrics.editedFiles).toEqual([SOURCE])
  })
})

describe('patchedFiles', () => {
  it('lists added, updated, deleted, and moved-to files', () => {
    expect(patchedFiles('*** Begin Patch\n*** Add File: a.ts\n*** Update File: b.ts\n*** Move to: c.ts\n*** Delete File: d.ts\n*** End Patch'))
      .toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
  })
})

describe('codexArgs and codexEnv', () => {
  it('points Codex at the provider, off web search, with the key in its own variable', () => {
    const args = codexArgs('fix it', PROVIDER, 'lynx-harness', 'C:\\h\\catalog.json')
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'])
    expect(args).toContain('model=\'lynx-harness\'')
    expect(args).toContain('model_catalog_json=\'C:\\h\\catalog.json\'')
    expect(args).toContain('web_search="disabled"')
    expect(args.at(-1)).toBe('fix it')
    expect(args.join(' ')).not.toContain('sk-test')

    const env = codexEnv({ PATH: '/bin' }, PROVIDER, '/home/codex')
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/home/codex', ELEMENTAL_EVAL_CODEX_KEY: 'sk-test' })
  })

  it('refuses a value it cannot quote', () => {
    expect(() => codexArgs('x', PROVIDER, 'it\'s', 'c.json')).toThrow(/literal string/)
  })
})

describe('codexModelCatalog', () => {
  it('copies the first freeform apply_patch model without OpenAI-only features or a default effort', () => {
    const cache = {
      models: [
        { slug: 'old', apply_patch_tool_type: 'function', model_messages: {} },
        {
          slug: 'gpt-x',
          apply_patch_tool_type: 'freeform',
          shell_type: 'unified_exec',
          model_messages: { instructions_template: 'You are Codex.' },
          tool_mode: 'code_mode_only',
          use_responses_lite: true,
          supports_search_tool: true,
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }],
          default_verbosity: 'low',
          support_verbosity: true,
        },
      ],
    }
    const { catalog, basedOn } = codexModelCatalog(cache, 'lynx-harness')
    expect(basedOn).toBe('gpt-x')
    const [model] = catalog.models
    expect(model).toMatchObject({
      slug: 'lynx-harness',
      shell_type: 'unified_exec',
      apply_patch_tool_type: 'freeform',
      model_messages: { instructions_template: 'You are Codex.' },
      use_responses_lite: false,
      supports_search_tool: false,
      supported_reasoning_levels: [],
      support_verbosity: false,
    })
    expect(model).not.toHaveProperty('tool_mode')
    expect(model).not.toHaveProperty('default_reasoning_level')
    expect(model).not.toHaveProperty('default_verbosity')
  })

  it('fails loudly when the cache has no usable model', () => {
    expect(() => codexModelCatalog({ models: [] }, 'm')).toThrow(/freeform apply_patch/)
  })
})
