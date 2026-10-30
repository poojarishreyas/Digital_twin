/**
 * File-finding evaluation runner.
 *
 * For each task mined from a repository's bug-fix history: prepare a workspace
 * with the fix's source reverted, confirm the fix's tests fail, run the agent
 * headless through the shipped base profile with the failing output as its
 * task, re-run the tests, and record file-finding metrics from the session.
 *
 * Usage:
 *   pnpm run eval:file-finding -- --repo <git repo> [--limit 10] [--out eval-results]
 *     [--install "pnpm install --prefer-offline"] [--keep] [--dry-run] [--hard] [--only <id,...>]
 *     [--agent elemental|claude-code|codex] [--provider <id>] [--model <id>]
 *     [--overlay <cordis.yml> ...] [--label <name>]
 *
 * `--dry-run` stops after preparing and validating each task, so it needs no
 * model key. A full run needs the provider key (DEEPSEEK_API_KEY by default).
 * `--hard` keeps only tasks where the failing test does not lead straight to
 * the fix (see `difficultyTags`), taken round-robin across those kinds.
 * `--agent claude-code` runs the installed `claude` CLI on the same tasks
 * instead, with the same prompt, scored by the same metrics. `--provider` and
 * `--model` pick the model for either agent; for Claude Code, `--provider`
 * names a provider in `--home-from` to use instead of its own login, so both
 * agents can run the same model. `--agent codex` does the same with the
 * installed `codex` CLI, which always runs `--provider` from `--home-from`.
 * `--overlay` layers more config over the harness agent's profile (repeatable),
 * to compare a variant such as `eval-bash.cordis.yml` on the same tasks;
 * `--label` names the variant in `summary.json`.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveExampleLaunch } from '@elemental/loader-smoke'
import { load } from 'js-yaml'
import { claudeCodeArgs, claudeCodeEnv, parseClaudeCodeOutput } from './claude-code.ts'
import type { ClaudeCodeProvider } from './claude-code.ts'
import { workspaceProcessIds } from './processes.ts'
import type { ProcessRow } from './processes.ts'
import { codexArgs, codexEnv, codexModelCatalog, codexThreadId, parseCodexRun } from './codex.ts'
import { computeMetrics, promptTokens, summarize } from './metrics.ts'
import type { EvalEvent, EvalUsage, RunMetrics } from './metrics.ts'
import { difficultyTags, mineTasks, prepareWorkspace, readTestSources, removeWorkspace, taskPrompt } from './tasks.ts'
import type { EvalTask, TaskTag } from './tasks.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const DRIVER = join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/base-driver.ts')
const OVERLAY = join(repoRoot, 'scripts/eval/eval.cordis.yml')
const TSCONFIG = join(repoRoot, 'tsconfig.json')
const MAX_FAILURE_CHARS = 6_000
const LOCALE_FILE = /(^|\/)locales?(\/|\.ts$|\.tsx$)/

/** Outcome of one task. */
interface TaskResult {
  readonly task: EvalTask
  readonly tags: readonly TaskTag[]
  readonly status: 'valid' | 'invalid' | 'ran' | 'error'
  readonly passed: boolean
  readonly metrics?: RunMetrics
  readonly finalText?: string
  /** Model the endpoint reported answering, when the agent's output names it. */
  readonly model?: string
  /** Wall time of the agent run alone, without install or tests. */
  readonly agentSeconds?: number
  readonly note?: string
}

interface Command {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function exec(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Command> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, shell: process.platform === 'win32' && !command.endsWith('.exe'), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function runTests(workspace: string, files: readonly string[]): Promise<Command> {
  // One worker: a task runs only a few spec files, and parallel workers can exhaust memory on a laptop.
  return exec('npx', ['vitest', 'run', '--maxWorkers=1', ...files], workspace, process.env, 15 * 60_000)
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `[... ${text.length - max} earlier characters omitted ...]\n${text.slice(-max)}`
}

/** Parse the driver's JSONL stdout into session events and the final result row. */
function parseDriverOutput(stdout: string): { events: EvalEvent[]; usage?: EvalUsage; output?: string } {
  const events: EvalEvent[] = []
  let usage: EvalUsage | undefined
  let output: string | undefined
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: { type?: string; event?: EvalEvent; usage?: EvalUsage; output?: string }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      // Non-JSON log lines from plugins are not events.
      continue
    }
    if (row.type === 'session_event' && row.event !== undefined) events.push(row.event)
    if (row.type === 'result') {
      usage = row.usage
      output = row.output
    }
  }
  return { events, ...usage === undefined ? {} : { usage }, ...output === undefined ? {} : { output } }
}

/** The error message of a turn that ended in error, e.g. a model provider rejecting every request. */
function turnErrorOf(events: readonly EvalEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = event.data.reason as { kind?: string; error?: { message?: string } } | undefined
    if (reason?.kind === 'error') return reason.error?.message ?? 'unknown error'
  }
  return undefined
}

/** Which agent works the tasks. */
type AgentKind = 'elemental' | 'claude-code' | 'codex'

interface RunOptions {
  readonly agent: AgentKind
  /** Provider id for `elemental`; `ELEMENTAL_EVAL_PROVIDER` or the overlay's default when undefined. */
  readonly provider?: string
  /** Model id for either agent; the agent's own default when undefined. */
  readonly model?: string
  /** Environment for `claude-code`; `process.env` when undefined. */
  readonly claudeEnv?: NodeJS.ProcessEnv
  /** Endpoint and key for `codex`, read from `--home-from`. */
  readonly codexProvider?: ClaudeCodeProvider
  readonly repo: string
  /** Directory that receives `<task>.events.jsonl`, the run's session events, for diagnosing a failure. */
  readonly out: string
  readonly install: string
  readonly keep: boolean
  readonly dryRun: boolean
  /** Existing Elemental home whose settings and stored credentials the agent run should use. */
  readonly homeFrom?: string
  /** Absolute paths of further overlays for `elemental`, applied after the eval overlay in order. */
  readonly overlays?: readonly string[]
}

/** Files copied from `--home-from`: provider settings and the credential store they reference. */
const HOME_FILES = ['settings.yaml', '.credentials.yaml']

async function runTask(task: EvalTask, options: RunOptions): Promise<Omit<TaskResult, 'tags'>> {
  const workspace = join(tmpdir(), `elemental-eval-${task.id}`)
  // Kept outside the repository and deleted after the task, since it may hold copied credentials.
  const home = join(tmpdir(), `elemental-eval-home-${task.id}`)
  // A previous run's leftover process would hold the old workspace open and fail its removal.
  await killWorkspaceProcesses(workspace)
  await rm(workspace, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  try {
    await prepareWorkspace(options.repo, task, workspace)
    const [installCommand = 'pnpm', ...installArgs] = options.install.split(' ')
    const install = await exec(installCommand, installArgs, workspace, process.env, 30 * 60_000)
    // pnpm reports its errors on stdout.
    if (install.code !== 0) {
      return { task, status: 'error', passed: false, note: `install failed: ${tail(install.stderr.trim() || install.stdout, 800)}` }
    }

    const baseline = await runTests(workspace, task.testFiles)
    if (baseline.code === 0) {
      return { task, status: 'invalid', passed: false, note: `tests pass without the fix:\n${tail(baseline.stdout, 1_500)}` }
    }
    if (options.dryRun) return { task, status: 'valid', passed: false, note: 'dry run: prepared and validated' }

    const prompt = taskPrompt(task, tail(`${baseline.stdout}\n${baseline.stderr}`, MAX_FAILURE_CHARS))
    const dirtyBefore = await changedFiles(workspace)
    const started = performance.now()
    const run = await runAgent(task, prompt, workspace, home, options)
    const agentSeconds = Math.round((performance.now() - started) / 1000)
    // Agents can leave background commands running (a test watcher, a long test run); they use
    // memory and could still change files, so they end with the agent's turn.
    await killWorkspaceProcesses(workspace)
    await writeFile(join(options.out, `${task.id}.events.jsonl`), run.events.map(event => `${JSON.stringify(event)}\n`).join(''))
    const dirtyAfter = await changedFiles(workspace)
    // Files the agent changed, whatever tool it used; install and baseline tests dirtied the ones already listed.
    const changed = dirtyBefore === undefined || dirtyAfter === undefined
      ? undefined
      : dirtyAfter.filter(file => !dirtyBefore.includes(file))
    const metrics = computeMetrics(run.events, { workspace, sourceFiles: task.sourceFiles, testFiles: task.testFiles }, run.usage, changed)
    // Keep the metrics: how far the agent got before the provider failed shows whether the failure is the model's.
    if (run.error !== undefined) return { task, status: 'error', passed: false, metrics, agentSeconds, note: `agent turn failed: ${run.error}` }
    if (run.code !== 0 && metrics.steps === 0) {
      return { task, status: 'error', passed: false, metrics, agentSeconds, note: `agent never started: exited ${String(run.code)}: ${tail(run.stderr, 800)}` }
    }
    const after = await runTests(workspace, task.testFiles)
    return {
      task,
      status: 'ran',
      passed: after.code === 0 && !metrics.editedTests,
      metrics,
      agentSeconds,
      ...run.output === undefined ? {} : { finalText: run.output },
      ...run.model === undefined ? {} : { model: run.model },
      ...run.code === 0 ? {} : { note: `agent exited ${String(run.code)}: ${tail(run.stderr, 800)}` },
    }
  } catch (error: unknown) {
    return { task, status: 'error', passed: false, note: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(home, { recursive: true, force: true })
    // An agent's leftover process can hold the workspace open (EBUSY on Windows);
    // losing the directory must not lose the finished result.
    if (!options.keep) {
      await removeWorkspace(workspace).catch((error: unknown) => {
        process.stdout.write(`eval: ${task.id} workspace not removed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
    }
  }
}

/** One agent run, normalized to harness session events. */
interface AgentRun {
  readonly code: number | null
  readonly stderr: string
  readonly events: readonly EvalEvent[]
  readonly usage?: EvalUsage
  readonly output?: string
  /** Why the run failed before finishing, e.g. a provider rejecting every request. */
  readonly error?: string
  readonly model?: string
}

async function runHarness(prompt: string, workspace: string, home: string, options: RunOptions): Promise<AgentRun> {
  const { homeFrom, provider, model, overlays = [] } = options
  await mkdir(home, { recursive: true })
  if (homeFrom !== undefined) {
    for (const file of HOME_FILES) {
      await copyFile(join(homeFrom, file), join(home, file)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }
  const launch = resolveExampleLaunch({
    srcBin: DRIVER,
    libBin: DRIVER,
    mode: 'src',
    tsconfigPath: TSCONFIG,
    configArgs: [JSON.stringify([OVERLAY, ...overlays]), prompt],
    env: {
      ELEMENTAL_HOME: home,
      ELEMENTAL_TELEMETRY_DISABLED: '1',
      ...provider === undefined ? {} : { ELEMENTAL_EVAL_PROVIDER: provider },
      ...model === undefined ? {} : { ELEMENTAL_EVAL_MODEL: model },
    },
  })
  const agent = await exec(launch.command, launch.args, workspace, { ...process.env, ...launch.env }, 60 * 60_000)
  const parsed = parseDriverOutput(agent.stdout)
  const error = turnErrorOf(parsed.events)
  return { code: agent.code, stderr: agent.stderr, ...parsed, ...error === undefined ? {} : { error } }
}

function runAgent(task: EvalTask, prompt: string, workspace: string, home: string, options: RunOptions): Promise<AgentRun> {
  switch (options.agent) {
    case 'claude-code': return runClaudeCode(prompt, workspace, options.model, options.claudeEnv ?? process.env)
    case 'codex': {
      if (options.codexProvider === undefined || options.model === undefined) throw new Error('codex needs a provider and a model')
      return runCodex(prompt, workspace, task.id, options.codexProvider, options.model)
    }
    case 'elemental': return runHarness(prompt, workspace, home, options)
  }
}

/**
 * Stop every process whose command line names the workspace, such as test runs an agent
 * started in the background and left behind when its turn ended.
 * @param workspace - the task workspace.
 */
async function killWorkspaceProcesses(workspace: string): Promise<void> {
  if (process.platform !== 'win32') {
    await execDirect('pkill', ['-f', workspace], tmpdir(), process.env, 60_000)
    return
  }
  const listing = await execDirect('powershell.exe', [
    '-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress',
  ], tmpdir(), process.env, 60_000)
  const pids = workspaceProcessIds(JSON.parse(listing.stdout || '[]') as ProcessRow[], workspace, process.pid)
  for (const pid of pids) await execDirect('taskkill', ['/PID', String(pid), '/T', '/F'], tmpdir(), process.env, 60_000)
}

/** Agent-owned directories that are not part of a fix. */
const AGENT_DIRS = /^\.(?:claude|codex|elemental)\//

/**
 * Files git reports as modified or untracked in a workspace.
 * @param workspace - a task workspace, which is a git repository.
 * @returns workspace-relative paths, or undefined when git cannot tell.
 */
async function changedFiles(workspace: string): Promise<string[] | undefined> {
  const status = await exec('git', ['status', '--porcelain', '--untracked-files=all', '-z'], workspace, process.env, 60_000)
  if (status.code !== 0) return undefined
  const files: string[] = []
  const entries = status.stdout.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? ''
    if (entry.length < 4) continue
    files.push(entry.slice(3))
    // A rename or copy is followed by its source path.
    if (/^[RC]|^.[RC]/.test(entry)) index += 1
  }
  return files.filter(file => !AGENT_DIRS.test(file))
}

async function runCodex(prompt: string, workspace: string, taskId: string, provider: ClaudeCodeProvider, model: string): Promise<AgentRun> {
  // Outside the system temp directory: Codex refuses to install its apply_patch helper there.
  const home = join(homedir(), '.elemental-eval', `codex-home-${taskId}`)
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  try {
    const cachePath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json')
    const { catalog } = codexModelCatalog(JSON.parse(await readFile(cachePath, 'utf8')) as unknown, model)
    const catalogPath = join(home, 'model-catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog))
    const [command = 'codex', ...prefix] = codexCommand()
    const args = [...prefix, ...codexArgs(prompt, provider, model, catalogPath)]
    const agent = await execDirect(command, args, workspace, codexEnv(process.env, provider, home), 60 * 60_000)
    const threadId = codexThreadId(agent.stdout)
    const sessions = join(home, 'sessions')
    const rolloutName = threadId === undefined || !existsSync(sessions)
      ? undefined
      : (await readdir(sessions, { recursive: true })).find(name => name.endsWith(`${threadId}.jsonl`))
    const rollout = rolloutName === undefined ? undefined : await readFile(join(sessions, rolloutName), 'utf8')
    return { code: agent.code, stderr: agent.stderr, ...parseCodexRun(agent.stdout, rollout) }
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * How to start the installed `codex`. On Windows npm installs a `.cmd` shim,
 * which cannot be spawned without a shell that would mangle the prompt, so the
 * shim's Node entry point is run directly.
 */
function codexCommand(): string[] {
  if (process.platform !== 'win32') return ['codex']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(join(dir, 'codex.cmd')) && existsSync(entry)) return [process.execPath, entry]
  }
  throw new Error('codex is not on PATH; install it with npm install -g @openai/codex')
}

async function runClaudeCode(prompt: string, workspace: string, model: string | undefined, env: NodeJS.ProcessEnv): Promise<AgentRun> {
  // No shell: the prompt holds quotes and newlines a shell would mangle.
  const agent = await execDirect('claude', claudeCodeArgs(prompt, model), workspace, env, 60 * 60_000)
  return { code: agent.code, stderr: agent.stderr, ...parseClaudeCodeOutput(agent.stdout) }
}

function execDirect(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Command> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { stderr += error.message })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/**
 * Read a provider's endpoint and key from a Elemental home, as the harness would use them.
 * @param home - the Elemental home directory.
 * @param id - provider id under `llm-pi-ai.providers` in `settings.yaml`.
 * @returns the provider's base URL and key; the key comes from the environment or the credential store's refs.
 */
async function readProvider(home: string, id: string): Promise<ClaudeCodeProvider> {
  type Settings = { 'llm-pi-ai'?: { providers?: Record<string, { baseURL?: string; apiKeyEnv?: string }> } }
  const provider = (load(await readFile(join(home, 'settings.yaml'), 'utf8')) as Settings | undefined)?.['llm-pi-ai']?.providers?.[id]
  if (provider?.baseURL === undefined || provider.apiKeyEnv === undefined) {
    throw new Error(`provider ${id} in ${home} needs a baseURL and an apiKeyEnv`)
  }
  const refs = (load(await readFile(join(home, '.credentials.yaml'), 'utf8')) as { refs?: Record<string, string> } | undefined)?.refs
  const apiKey = process.env[provider.apiKeyEnv] ?? refs?.[provider.apiKeyEnv]
  if (apiKey === undefined) throw new Error(`no key for provider ${id}: ${provider.apiKeyEnv} is neither set nor stored`)
  return { baseURL: provider.baseURL, apiKey }
}

function markdownTable(results: readonly TaskResult[]): string {
  const rows = results.map(result => [
    result.task.id,
    result.tags.join(', '),
    result.status,
    result.passed ? 'yes' : 'no',
    result.metrics?.editedExpected === true ? 'yes' : 'no',
    String(result.metrics?.firstSeenStep ?? '-'),
    String(result.metrics?.firstReadStep ?? '-'),
    String(result.metrics?.steps ?? '-'),
    String(result.metrics?.usage === undefined ? '-' : promptTokens(result.metrics.usage)),
    String(result.agentSeconds ?? '-'),
    result.task.subject.replaceAll('|', '/').slice(0, 60),
  ].join(' | '))
  return [
    '| task | difficulty | status | passed | right file edited | first seen step | first read step | steps | prompt tokens | agent seconds | subject |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row} |`),
  ].join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    // `pnpm run eval:file-finding -- --repo …` forwards the separator itself.
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      repo: { type: 'string' },
      limit: { type: 'string', default: '10' },
      out: { type: 'string', default: 'eval-results' },
      install: { type: 'string', default: 'pnpm install --prefer-offline' },
      keep: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'home-from': { type: 'string' },
      only: { type: 'string' },
      hard: { type: 'boolean', default: false },
      agent: { type: 'string', default: 'elemental' },
      overlay: { type: 'string', multiple: true },
      label: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  })
  if (values.repo === undefined) throw new Error('--repo <git repository with bug-fix history> is required')
  const dryRun = values['dry-run']
  const homeFrom = values['home-from'] === undefined ? undefined : resolve(values['home-from'])
  const agent = values.agent
  if (agent !== 'elemental' && agent !== 'claude-code' && agent !== 'codex') throw new Error(`--agent must be elemental, claude-code, or codex, got ${agent}`)
  if (!dryRun && agent === 'elemental' && homeFrom === undefined && process.env.DEEPSEEK_API_KEY === undefined) {
    throw new Error('no model credentials: set DEEPSEEK_API_KEY, pass --home-from <elemental home>, or use --dry-run')
  }
  const { provider, model } = values
  const overlays = (values.overlay ?? []).map(file => resolve(file))
  if (overlays.length > 0 && agent !== 'elemental') throw new Error('--overlay applies only to --agent elemental')
  if (agent === 'claude-code' && provider !== undefined && (homeFrom === undefined || model === undefined)) {
    throw new Error('--agent claude-code with --provider needs --home-from <elemental home> and --model <provider model id>')
  }
  if (agent === 'codex' && !dryRun && (provider === undefined || homeFrom === undefined || model === undefined)) {
    throw new Error('--agent codex needs --home-from <elemental home>, --provider <id>, and --model <provider model id>')
  }
  const claudeEnv = agent !== 'claude-code' || provider === undefined || homeFrom === undefined || model === undefined
    ? undefined
    : claudeCodeEnv(process.env, await readProvider(homeFrom, provider), model)
  const codexProvider = agent !== 'codex' || provider === undefined || homeFrom === undefined
    ? undefined
    : await readProvider(homeFrom, provider)
  const repo = resolve(values.repo)
  const out = resolve(values.out)
  await mkdir(out, { recursive: true })

  const limit = Number(values.limit)
  const only = values.only?.split(',').map(id => id.trim()).filter(Boolean)
  const candidates = (await mineTasks(repo, Number.MAX_SAFE_INTEGER))
    .filter(task => !task.sourceFiles.every(file => LOCALE_FILE.test(file)))
    .filter(task => only === undefined || only.some(id => task.fixCommit.startsWith(id)))
  const tags = new Map<EvalTask, TaskTag[]>()
  const tasks = await selectTasks(candidates, limit, values.hard, async (task) => {
    const taskTags = difficultyTags(task, await readTestSources(repo, task))
    tags.set(task, taskTags)
    return taskTags
  })
  process.stdout.write(`eval: ${tasks.length} task(s) from ${repo} with ${agent}${dryRun ? ' (dry run)' : ''}\n`)

  const results: TaskResult[] = []
  for (const task of tasks) {
    process.stdout.write(`eval: ${task.id} [${(tags.get(task) ?? []).join(', ')}] ${task.subject}\n`)
    const result = { tags: tags.get(task) ?? [], ...await runTask(task, {
      agent,
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      ...claudeEnv === undefined ? {} : { claudeEnv },
      ...codexProvider === undefined ? {} : { codexProvider },
      repo,
      out,
      install: values.install,
      keep: values.keep,
      dryRun,
      ...homeFrom === undefined ? {} : { homeFrom },
      ...overlays.length === 0 ? {} : { overlays },
    }) }
    results.push(result)
    await writeFile(join(out, `${task.id}.json`), `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`eval: ${task.id} -> ${result.status}${result.passed ? ' (passed)' : ''}${result.note === undefined ? '' : ` — ${result.note.split('\n')[0]}`}\n`)
  }

  const ran = results.flatMap(result => result.status === 'ran' && result.metrics !== undefined
    ? [{ passed: result.passed, metrics: result.metrics }]
    : [])
  const byStatus = countBy(results.map(result => result.status))
  const summary = { agent: values.label ?? agent, tasks: results.length, byStatus, ...summarize(ran) }
  await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(join(out, 'summary.md'), `${markdownTable(results)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

/** Most candidates tagged while hunting for hard tasks; each tag reads test files from git. */
const MAX_TAGGED = 400
const HARD_TAGS: readonly TaskTag[] = ['cross-package', 'indirect', 'multi-file']

/**
 * Pick the tasks to run: the first `limit` candidates, or with `hard` a
 * round-robin over the hard kinds so each is represented.
 */
async function selectTasks(
  candidates: readonly EvalTask[],
  limit: number,
  hard: boolean,
  tag: (task: EvalTask) => Promise<TaskTag[]>,
): Promise<EvalTask[]> {
  if (!hard) {
    const chosen = candidates.slice(0, limit)
    for (const task of chosen) await tag(task)
    return chosen
  }
  const byKind = new Map<TaskTag, EvalTask[]>(HARD_TAGS.map(kind => [kind, []]))
  for (const task of candidates.slice(0, MAX_TAGGED)) {
    const taskTags = await tag(task)
    for (const kind of HARD_TAGS) if (taskTags.includes(kind)) byKind.get(kind)?.push(task)
    if (HARD_TAGS.every(kind => (byKind.get(kind)?.length ?? 0) >= limit)) break
  }
  const chosen: EvalTask[] = []
  while (chosen.length < limit) {
    const before = chosen.length
    for (const kind of HARD_TAGS) {
      const next = byKind.get(kind)?.find(task => !chosen.includes(task))
      if (next !== undefined && chosen.length < limit) chosen.push(next)
    }
    if (chosen.length === before) break
  }
  return chosen
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

await main()
