# File-finding evaluation

Measures how well the agent finds and fixes the right code before any navigation feature (symbol tools, a code graph, co-change ranking) is built. A feature ships only if it moves these numbers.

## How a task is made

Tasks come from a repository's own bug-fix history. A commit qualifies when its subject reads like a fix (or it adds a `bug-fix` Agent Note), it changes 1–3 package or app source files, it changes at least one `tests/**/*.spec.ts` file, and it touches at most 12 files. Tasks that only change locale files are skipped, because a copy edit says little about file-finding.

For each task the runner:

1. checks out the fix commit, restores the source files to the parent commit while keeping the fix's tests, and makes the result a new repository with one commit, so no git history shows the agent the fix;
2. installs dependencies and runs those tests, and drops the task if they already pass;
3. gives the agent the failing test output as its only instruction — the source files and the commit subject are not revealed;
4. runs the agent headless through the shipped base profile (`packages/test-support/loader-smoke/tests/fixtures/base-driver.ts` with [`eval.cordis.yml`](eval.cordis.yml));
5. re-runs the tests and computes metrics from the streamed session events.

## Difficulty

Each task is tagged by what makes its file hard to find from the failing test:

| Tag | Meaning |
|---|---|
| `cross-package` | A fix file lives in a different package or app than every failing test |
| `indirect` | No failing test imports a fix file, so the agent must trace the call path |
| `multi-file` | The fix spans more than one source file, and all must be found |
| `direct` | None of the above: the test imports the fix file in its own package (the control case) |

`--hard` runs only tagged tasks, taking `cross-package`, `indirect`, and `multi-file` in turn so each kind is represented. Tags appear in the log, each `<task>.json`, and `summary.md`.

## Metrics

| Metric | Meaning |
|---|---|
| passed | The fix's tests pass afterwards and no test file was edited |
| right file edited | At least one of the real fix's source files was edited |
| first seen step | First step whose search results or reads named a real fix file |
| first read step | First step that read a real fix file |
| reads before correct | File reads before that first correct read |
| steps, tool calls | Model responses and tool calls the run took |
| prompt tokens | Every input token sent, cached or not, so agents with different caching compare fairly |
| agent seconds | Wall time of the agent run alone, without install or tests |
| extra edits | Files changed that are neither fix sources nor tests |

A read is a `read` tool call or a shell command that prints a file with a viewer (`cat`, `Get-Content`, `sed -n`, `head`, `tail`, `nl`, …), so an agent that reads only through its shell, like Codex, is scored the same way. Search commands such as `rg` are not reads; their output counts toward "first seen". Edited files come from `git status` in the workspace after the run, so edits made through a shell count too.

`summary.json` aggregates pass count, correct-file count, and medians; `summary.md` is a per-task table; `<task>.json` holds each run's full metrics and final answer; `<task>.events.jsonl` holds the run's tool calls and results, to see why a run failed.

## Running it

```sh
# Prepare and validate tasks only; no model key needed.
pnpm run eval:file-finding -- --repo <path-to-repo> --limit 5 --dry-run

# Full run; needs DEEPSEEK_API_KEY (model via --provider / --model, or ELEMENTAL_EVAL_PROVIDER / ELEMENTAL_EVAL_MODEL).
pnpm run eval:file-finding -- --repo <path-to-repo> --limit 20 --out eval-results

# Edge cases only: tasks where the failing test does not lead straight to the fix.
pnpm run eval:file-finding -- --repo <path-to-repo> --hard --limit 6

# A model from an existing Elemental home (e.g. a custom provider), and specific tasks.
pnpm run eval:file-finding -- --repo <path-to-repo> --home-from ~/.elemental --provider <provider id> --model <model id> --only <hash>,<hash>

# The same tasks worked by Claude Code (the installed `claude` CLI), for comparison.
pnpm run eval:file-finding -- --repo <path-to-repo> --hard --limit 6 --agent claude-code --model sonnet

# Claude Code on the same provider and model as the harness: change only --agent.
pnpm run eval:file-finding -- --repo <path-to-repo> --hard --limit 6 --agent claude-code --home-from ~/.elemental --provider <provider id> --model <model id>

# Codex (the installed `codex` CLI) on the same provider and model.
pnpm run eval:file-finding -- --repo <path-to-repo> --hard --limit 6 --agent codex --home-from ~/.elemental --provider <provider id> --model <model id>

# One report comparing the runs, each from its own --out directory.
pnpm exec tsx scripts/eval/compare-runs.ts eval-elemental eval-claude-code eval-codex --md comparison.md
```

This repository's history is squashed, so mine a repository with real history, such as a clone of the upstream `deepseek-ai/deepseek-harness`. A blobless clone (`git clone --filter=blob:none`) is enough. `--install` overrides the dependency command, and `--keep` leaves workspaces in place for inspection.

## Comparing with Claude Code

`--agent claude-code` gives the same prompt to `claude -p` in the same prepared workspace and scores its stream-json output with the same metrics. It loads only project settings and no MCP servers, so your own hooks, plugins, and servers do not change the result. It runs with permission checks bypassed and no sandbox, confined only by working in a throwaway workspace. It authenticates however your `claude` does, unless `--provider` names a provider from the `--home-from` Elemental home: then it uses that provider's base URL and key, and every model tier and subagent runs `--model`. The provider must also serve the Anthropic Messages API (`/v1/messages`), as OmniRoute does. `<task>.json` records the model the endpoint reported answering.

## Comparing with Codex

`--agent codex` gives the same prompt to `codex exec --json` in the same workspace, with approvals and the sandbox off as for Claude Code. It always runs `--provider` from `--home-from` over the OpenAI Responses API (`/v1/responses`), which OmniRoute also serves. Each run gets a fresh `CODEX_HOME` under `~/.elemental-eval` (Codex refuses to install its `apply_patch` helper under the system temp directory), so your Codex config, plugins, memories, and global `AGENTS.md` do not change the result.

Codex has no metadata for a gateway model and would fall back to a reduced tool set without `apply_patch`. The runner therefore writes a one-model catalog that copies the tool setup and prompt template of the first model in the installed Codex's `models_cache.json` that edits through freeform `apply_patch`, minus what only OpenAI's servers support (code mode, Responses lite, hosted search) and minus a default reasoning effort, which the other agents do not send either. Web search is off: no task needs it, and OmniRoute's Gemini translation answers a request carrying Codex's built-in `web_search` tool with search alone, dropping the shell. Steps, tool calls, and token counts come from the run's rollout file, which records one token count per model response.

A comparison measures the harness only when every agent uses the same model. Run each agent on the same task list into its own `--out` directory, then compare them with `compare-runs.ts`. Its cost rows total tokens only over tasks every agent passed, so an agent that gave up early does not look cheap, and they show cost both with caching and without it, since a gateway may cache one API better than another.

## Limits

- The agent runs the base profile with workspace-write sandboxing and no approval prompts; the web presets add their own compaction rows, so compaction behavior can differ slightly from the web app.
- The prompt names the failing test files, which hints at the package; the metrics measure finding the source file within that hint.
- One run per task is noisy. Compare feature variants on the same tasks and several runs before drawing conclusions.
