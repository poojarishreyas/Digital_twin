/**
 * Side-by-side report of several agents' file-finding evaluation runs: task
 * completion, how fast the fix file was found, token cost, and agent wall time.
 * Pure; `compare-runs.ts` reads the run directories.
 */

import { median, promptTokens } from './metrics.ts'
import type { RunMetrics } from './metrics.ts'

/** The fields of a `<task>.json` result the report reads. */
export interface RunRecord {
  readonly task: { readonly id: string; readonly subject: string }
  readonly tags: readonly string[]
  readonly status: string
  readonly passed: boolean
  readonly metrics?: RunMetrics
  readonly agentSeconds?: number
  readonly note?: string
}

/** One agent's results. */
export interface AgentRuns {
  readonly agent: string
  readonly results: readonly RunRecord[]
}

/** USD per million tokens, the same rates the Lynx benchmark prices with. */
export const PRICES = { uncachedInput: 2, cachedInput: 0.1, output: 10 } as const

/**
 * Estimated cost of one run.
 * @param metrics - the run's metrics.
 * @param cached - price cache reads at the cached rate; false prices every input token as uncached,
 *   which removes differences in how well the gateway caches for each agent's API.
 * @returns USD, or 0 when the run reported no usage.
 */
export function runCost(metrics: RunMetrics | undefined, cached: boolean): number {
  const usage = metrics?.usage
  if (usage === undefined) return 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const uncached = cached ? promptTokens(usage) - cacheRead : promptTokens(usage)
  return (uncached * PRICES.uncachedInput + (cached ? cacheRead * PRICES.cachedInput : 0) + usage.outputTokens * PRICES.output) / 1_000_000
}

/**
 * The comparison report.
 * @param agents - each agent's results; tasks are matched by id.
 * @returns Markdown with a headline table and a per-task table.
 */
export function compareMarkdown(agents: readonly AgentRuns[]): string {
  const taskIds = [...new Set(agents.flatMap(agent => agent.results.map(result => result.task.id)))]
  const byId = agents.map(agent => new Map(agent.results.map(result => [result.task.id, result])))
  // Token totals compare only where every agent passed, so a run that gave up early does not look cheap.
  const allPassed = taskIds.filter(id => byId.every(results => results.get(id)?.passed === true))

  const row = (label: string, value: (results: readonly RunRecord[], agent: number) => string): string =>
    `| ${label} | ${agents.map((agent, index) => value(agent.results, index)).join(' | ')} |`
  const over = (results: readonly RunRecord[], pick: (metrics: RunMetrics) => number | null): string =>
    format(median(results.flatMap(result => result.metrics === undefined ? [] : pick(result.metrics) ?? [])))
  const onAllPassed = (agent: number, pick: (result: RunRecord) => number): number =>
    allPassed.reduce((total, id) => total + pick(byId[agent]?.get(id) as RunRecord), 0)

  const lines = [
    `| | ${agents.map(agent => agent.agent).join(' | ')} |`,
    `|---|${agents.map(() => '---:').join('|')}|`,
    '| **Task completion** | |',
    row('Tests pass', results => `${count(results, result => result.passed)} / ${results.length}`),
    row('Right file edited', results => `${count(results, result => result.metrics?.editedExpected === true)} / ${results.length}`),
    row('Edited a test file', results => String(count(results, result => result.metrics?.editedTests === true))),
    row('Runs that errored (gateway or agent)', results => String(count(results, result => result.status === 'error'))),
    '| **Retrieval** | |',
    row('Median step the fix file was first seen', results => over(results, metrics => metrics.firstSeenStep)),
    row('Median step the fix file was first read', results => over(results, metrics => metrics.firstReadStep)),
    row('Median file reads before the right one', results => over(results, metrics => metrics.readsBeforeCorrect)),
    row('Median steps per task', results => over(results, metrics => metrics.steps)),
    row('Median tool calls per task', results => over(results, metrics => Object.values(metrics.toolCalls).reduce((sum, calls) => sum + calls, 0))),
    '| **Cost** | |',
    row(`Prompt tokens on the ${allPassed.length} task(s) all passed`, (_, agent) => thousands(onAllPassed(agent, result => usagePrompt(result)))),
    row('Output tokens on those tasks', (_, agent) => thousands(onAllPassed(agent, result => result.metrics?.usage?.outputTokens ?? 0))),
    row('Est. cost on those tasks, with caching', (_, agent) => dollars(onAllPassed(agent, result => runCost(result.metrics, true)))),
    row('Est. cost on those tasks, no caching', (_, agent) => dollars(onAllPassed(agent, result => runCost(result.metrics, false)))),
    row('Prompt tokens, all runs', results => thousands(results.reduce((sum, result) => sum + usagePrompt(result), 0))),
    row('Cached share of prompt tokens', results => cachedShare(results)),
    '| **Time** | |',
    row('Median agent seconds per task', results => format(median(results.flatMap(result => result.agentSeconds ?? [])))),
  ]

  const taskRows = taskIds.map((id) => {
    const first = byId.find(results => results.has(id))?.get(id)
    const cells = byId.map((results) => {
      const result = results.get(id)
      if (result === undefined) return '-'
      const verdict = result.status === 'error' ? 'error' : result.passed ? 'pass' : 'fail'
      const metrics = result.metrics
      if (metrics === undefined) return verdict
      return `${verdict}, ${metrics.steps} steps, seen ${metrics.firstSeenStep ?? '-'}, ${thousands(usagePrompt(result))} tok`
    })
    return `| ${id} | ${(first?.tags ?? []).join(', ')} | ${cells.join(' | ')} |`
  })

  return [
    '## Headline',
    '',
    ...lines,
    '',
    `Cost uses $${PRICES.uncachedInput}/M uncached input, $${PRICES.cachedInput}/M cached input, and $${PRICES.output}/M output. "No caching" prices every input token as uncached, which removes differences in how well the gateway caches each agent's API.`,
    '',
    '## Per task',
    '',
    `| task | difficulty | ${agents.map(agent => agent.agent).join(' | ')} |`,
    `|---|---|${agents.map(() => '---').join('|')}|`,
    ...taskRows,
    '',
  ].join('\n')
}

function usagePrompt(result: RunRecord): number {
  return result.metrics?.usage === undefined ? 0 : promptTokens(result.metrics.usage)
}

function cachedShare(results: readonly RunRecord[]): string {
  const prompt = results.reduce((sum, result) => sum + usagePrompt(result), 0)
  const cached = results.reduce((sum, result) => sum + (result.metrics?.usage?.cacheReadTokens ?? 0), 0)
  return prompt === 0 ? '-' : `${Math.round((cached / prompt) * 100)}%`
}

function count(results: readonly RunRecord[], test: (result: RunRecord) => boolean): number {
  return results.filter(test).length
}

function format(value: number | null): string {
  return value === null ? '-' : String(Math.round(value * 10) / 10)
}

function thousands(value: number): string {
  return value >= 10_000 ? `${Math.round(value / 1000)}K` : String(value)
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`
}
