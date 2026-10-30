import { describe, expect, it } from 'vitest'
import { compareMarkdown, runCost } from './compare.ts'
import type { RunRecord } from './compare.ts'
import type { RunMetrics } from './metrics.ts'

function run(id: string, passed: boolean, metrics: Partial<RunMetrics>, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    task: { id, subject: `fix ${id}` },
    tags: ['indirect'],
    status: 'ran',
    passed,
    metrics: {
      steps: 10,
      toolCalls: { read: 2, grep: 1 },
      firstSeenStep: 2,
      firstReadStep: 3,
      readsBeforeCorrect: 1,
      editedFiles: [],
      editedExpected: passed,
      extraEdits: [],
      editedTests: false,
      ...metrics,
    },
    ...extra,
  }
}

describe('runCost', () => {
  const metrics = { usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000 } } as RunMetrics
  it('prices cache reads at the cached rate, or as uncached input when caching is ignored', () => {
    expect(runCost(metrics, true)).toBeCloseTo(2 + 0.1 + 1)
    expect(runCost(metrics, false)).toBeCloseTo(4 + 1)
    expect(runCost(undefined, true)).toBe(0)
  })
})

describe('compareMarkdown', () => {
  it('compares completion, retrieval, and cost, with token totals only over tasks every agent passed', () => {
    const report = compareMarkdown([
      {
        agent: 'elemental',
        results: [
          run('t1', true, { steps: 8, usage: { inputTokens: 50_000, outputTokens: 1_000 } }, { agentSeconds: 60 }),
          run('t2', true, { steps: 20, usage: { inputTokens: 900_000, outputTokens: 1_000 } }, { agentSeconds: 100 }),
        ],
      },
      {
        agent: 'codex',
        results: [
          run('t1', true, { steps: 12, firstSeenStep: 4, usage: { inputTokens: 70_000, outputTokens: 2_000 } }, { agentSeconds: 80 }),
          run('t2', false, { steps: 3, usage: { inputTokens: 5_000, outputTokens: 100 } }, { status: 'error', note: '502' }),
        ],
      },
    ])
    expect(report).toContain('| | elemental | codex |')
    expect(report).toContain('| Tests pass | 2 / 2 | 1 / 2 |')
    expect(report).toContain('| Runs that errored (gateway or agent) | 0 | 1 |')
    expect(report).toContain('| Median step the fix file was first seen | 2 | 3 |')
    expect(report).toContain('| Prompt tokens on the 1 task(s) all passed | 50K | 70K |')
    expect(report).toContain('| Median agent seconds per task | 80 | 80 |')
    expect(report).toContain('| t2 | indirect | pass, 20 steps, seen 2, 900K tok | error, 3 steps, seen 2, 5000 tok |')
  })
})
