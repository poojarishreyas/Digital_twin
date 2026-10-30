# Agent Note: Shell tools tell the model to report, not repair, failures its change did not cause

Status: implemented

## Problem

The [file-finding evaluation](../testing/2026-09-29-file-finding-evaluation.md) runs from 2026-10-18 to 2026-10-20 put the harness level with Claude Code on the same model: every agent passed every task that ran. The harness lost on cost because of what it did after its fix passed. In elemental-v2 runs, 22–81% of prompt tokens went to steps after the failing tests were green. Those steps carry the largest context, so they are the most expensive in a run. Two patterns dominated:

- **Cycling through check variants.** The task repository has no per-package typecheck that works on an unbuilt checkout. `tsc -p <package>` fails with TS6305 because referenced packages are not built, `pnpm --filter <pkg> typecheck` has no script, and `pnpm run typecheck` builds the whole repository. The agent tried two to five variants per task, and each failure had nothing to do with its change.
- **Repairing the environment.** On task `ed34a1d7fe` the fix passed at step 42. The next 78 calls chased a missing `vite/dist/client/client.mjs` and shiki grammar files in `node_modules` (likely a damaged install on a full disk). They wrote placeholder modules into the package store and ran `pnpm install --force`, which took the run from about $1.30 to $2.55.

The only failure guidance in the prompt was the shell tools' "investigate failures before moving on". The base profile has no other task guidance, so the model read that sentence as an instruction to chase every failure.

## Decision

`shell` exports `FAILURE_TRIAGE_GUIDANCE`. Both `tool:bash` and `tool:pwsh` replace "investigate failures before moving on" with it:

- Investigate a failure the model's own work could have caused.
- A failure with a cause outside the change (an unbuilt project, a missing script, a timeout, broken installed dependencies) describes the environment. Unless the user asked for it, do not repair dependencies, build outputs, or toolchains, and do not cycle through variants of the same check.
- Say in the final answer what could not be verified and why, and continue with the checks that work.

The sentence lives in `shell`, beside the exit-marker contract both tools already share, so the twins cannot drift. "Unless the user asked for it" keeps the rule out of the way when repairing the environment is the task.

## Alternatives considered

**Answer an identical shell re-run with "unchanged since step N".** Rejected on the same run data, because no rule is both safe and useful. A pointer is only correct if nothing the command reads changed. A shell command can change anything, including ignored directories such as `node_modules`. Under a rule that requires every call between the two runs to be provably read-only (`read`, `grep`, `git status`, …), 4 of 84 repeated commands across all agents would have been answered, and only 1 of them was the harness's. Under a looser rule that requires only no edit-tool call in between, about 25 would have been answered, but 10 of those produced different output when actually re-run. On `ed34a1d7fe` the test output changed after `node_modules` was modified, so the pointer would have told the model something false.

**List the project's typecheck and test commands in the agent's instructions.** Rejected because nothing correct was available to list. The guessing came from the missing per-package typecheck on an unbuilt checkout, not from not knowing the scripts. The root `package.json` already names `typecheck`, and running it builds everything.

**A hard guard against writes under `node_modules`.** Deferred. It would have stopped the environment repair, but it is a policy decision for `shell-permission-policy`, and installing a dependency is legitimate when the user asks for it.

## Consequences

- Every composition that mounts `bash` or `pwsh` gets the longer section, about 90 more prompt tokens per request. Recorded-session system-prompt sidecars that contain the section changed text.
- The rule is prompt guidance, so its effect has to be measured: re-run the evaluation and compare tokens after the tests pass and calls classified as environment repair or failed check variants.
