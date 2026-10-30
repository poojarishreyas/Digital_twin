/**
 * Compare several agents' file-finding evaluation runs on the same tasks.
 *
 * Usage:
 *   pnpm exec tsx scripts/eval/compare-runs.ts <out dir> <out dir> ... [--md <report.md>]
 *
 * Each directory is one `run-eval.ts --out` of one agent.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { compareMarkdown } from './compare.ts'
import type { AgentRuns, RunRecord } from './compare.ts'

async function readRuns(dir: string): Promise<AgentRuns> {
  const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as { agent?: string }
  const files = (await readdir(dir)).filter(name => name.endsWith('.json') && name !== 'summary.json')
  const results = await Promise.all(files.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as RunRecord))
  return { agent: summary.agent ?? dir, results: results.sort((a, b) => a.task.id.localeCompare(b.task.id)) }
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { md: { type: 'string' } } })
if (positionals.length === 0) throw new Error('pass one or more run-eval --out directories')
const report = compareMarkdown(await Promise.all(positionals.map(readRuns)))
if (values.md !== undefined) await writeFile(values.md, report)
process.stdout.write(report)
