import { describe, expect, it } from 'vitest'
import { claudeCodeArgs, claudeCodeEnv, parseClaudeCodeOutput } from './claude-code.ts'
import { computeMetrics } from './metrics.ts'

const WORKSPACE = '/w'
const SOURCE = 'packages/a/b/src/a.ts'

// Rows shaped like a real `claude -p --output-format stream-json --verbose` run:
// one message id spans several rows, tool results come back as user rows.
function stream(rows: readonly unknown[]): string {
  return ['not json', ...rows.map(row => JSON.stringify(row))].join('\n')
}

const assistant = (id: string, content: unknown[], parent: string | null = null): unknown =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'qwen3-coder-next', content } })
const toolUse = (name: string, input: unknown): unknown => ({ type: 'tool_use', name, input })
const toolResult = (content: unknown): unknown => ({ type: 'user', message: { content: [{ type: 'tool_result', content }] } })

describe('parseClaudeCodeOutput', () => {
  it('counts one step per main-thread message and maps tools onto harness names', () => {
    const parsed = parseClaudeCodeOutput(stream([
      { type: 'system', subtype: 'init' },
      assistant('m1', [{ type: 'thinking' }]),
      assistant('m1', [toolUse('Grep', { pattern: 'x =' })]),
      toolResult(`${SOURCE}:1:export const x = 1`),
      assistant('m1', [toolUse('Read', { file_path: `${WORKSPACE}/${SOURCE}` })]),
      toolResult('1\texport const x = 1'),
      assistant('sub', [toolUse('Read', { file_path: `${WORKSPACE}/other.ts` })], 'toolu_1'),
      assistant('m2', [toolUse('Edit', { file_path: `${WORKSPACE}/${SOURCE}`, old_string: '1', new_string: '2' })]),
      toolResult('ok'),
      assistant('m3', [{ type: 'text', text: 'done' }]),
      {
        type: 'result',
        is_error: false,
        result: 'done',
        usage: { input_tokens: 26, output_tokens: 529, cache_read_input_tokens: 76_471, cache_creation_input_tokens: 38_725 },
      },
    ]))

    expect(parsed.usage).toEqual({ inputTokens: 26, outputTokens: 529, cacheReadTokens: 76_471, cacheWriteTokens: 38_725 })
    expect(parsed.output).toBe('done')
    expect(parsed.error).toBeUndefined()
    expect(parsed.model).toBe('qwen3-coder-next')

    const metrics = computeMetrics(parsed.events, { workspace: WORKSPACE, sourceFiles: [SOURCE], testFiles: [] }, parsed.usage)
    expect(metrics).toMatchObject({
      steps: 3,
      toolCalls: { grep: 1, read: 2, edit: 1 },
      firstSeenStep: 1,
      firstReadStep: 1,
      readsBeforeCorrect: 0,
      editedFiles: [SOURCE],
      editedExpected: true,
    })
  })

  it('reports a failed run and tolerates missing usage', () => {
    const parsed = parseClaudeCodeOutput(stream([{ type: 'result', is_error: true, result: 'API Error: 529' }]))
    expect(parsed).toEqual({ events: [], output: 'API Error: 529', error: 'API Error: 529' })
  })
})

describe('claudeCodeArgs', () => {
  it('isolates the run from user settings and MCP servers and passes the model only when given', () => {
    const args = claudeCodeArgs('fix it')
    expect(args.slice(0, 2)).toEqual(['-p', 'fix it'])
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--strict-mcp-config', 'bypassPermissions']))
    expect(args).not.toContain('--model')
    expect(claudeCodeArgs('fix it', 'sonnet').slice(-2)).toEqual(['--model', 'sonnet'])
  })
})

describe('claudeCodeEnv', () => {
  it('points Claude Code at the provider and pins every model tier to one model', () => {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'anthropic' }
    const env = claudeCodeEnv(base, { baseURL: 'http://localhost:20128/v1', apiKey: 'k' }, 'm')
    expect(env).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://localhost:20128',
      ANTHROPIC_AUTH_TOKEN: 'k',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm',
      CLAUDE_CODE_SUBAGENT_MODEL: 'm',
    })
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(base.ANTHROPIC_API_KEY).toBe('anthropic')
  })
})
