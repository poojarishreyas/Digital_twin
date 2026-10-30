# Agent Note: shell commands run outside the sandbox, guarded by permission rules and prompts

Status: implemented

## Problem

A three-way benchmark (elemental, Claude Code, Codex on the same model and the same upstream bug-fix tasks, `scripts/eval/`) showed elemental spending about 30% more prompt tokens than Claude Code. The traces traced most of it to the Windows sandbox, not to search or reading. Under the restricted-token sandbox a program cannot give a child process piped stdio, so vitest failed at startup with `spawn EPERM` and Git Bash could not start at all. The model then spent steps on workarounds — one run edited a file under `node_modules/vite` — and never escalated, because `spawn EPERM` matched none of the windows-acl denial signatures, so no escalation hint was shown. Claude Code ran unsandboxed in the comparison. With the sandbox off, elemental used 30% fewer prompt tokens, 43% fewer failed commands, and 16 instead of 91 steps between its first and last edit, and it used fewer tokens than Claude Code. The same failures reach every Windows user who runs tests.

## Decision

Shell commands follow Claude Code's model: the shell sandbox is opt-in and commands are guarded by permission rules and prompts.

- **New package `shell-permission-policy`** decides each `bash`/`pwsh` call before it runs. Commands run outside the sandbox by default. Allow rules or the built-in read-only list let a command run; otherwise the user is asked; deny rules refuse and ask rules always ask. `sandbox.enabled` confines commands under `workspace-write`, except `sandbox.excludedCommands`. The decision is enforced in the tools' `execute`, where the per-call sandbox policy is resolved, so foreground and background runs share it.
- **Rule syntax mirrors Claude Code's Bash rules** (exact, `prefix:*`, `*` wildcard with an optional trailing ` *`; deny > ask > allow; compound lines judged per simple command; wrappers and assignments stripped for deny/ask but only safe assignments for allow). Rules name the elemental tool (`bash(…)`, `pwsh(…)`); `Bash(…)` is accepted so copied rules work.
- **`allowed-always` is a new approval outcome**, with a `suggestedRules` request field. The policy saves the offered rules to `shell-permissions.workspaces.<root>.allow` in the user settings file; elemental has no project settings file to mirror Claude Code's `.claude/settings.local.json`. The approval service downgrades a ruleless `allowed-always` to `allowed-once`, and every other caller treats it as a one-shot grant.
- **Only the shell changes.** The session sandbox mode and permission presets still drive the file-tool fence, so file writes stay inside the workspace by default; Claude Code also governs file edits separately from `sandbox.enabled`.
- **Delegated children cannot be asked**, so an unapproved command keeps the child's standing sandbox policy (confined under `workspace-write`) instead of being refused; a user-chosen `never` policy (Full access) runs it.
- **`operation not permitted` and `eperm` join the windows-acl denial signatures**, so with the sandbox enabled a `spawn EPERM` shows the denial marker and escalation hint.

## Alternatives considered

- **Switching the default preset to `danger-full-access`** would also lift the file-tool fence and run every command without a prompt — less safe than Claude Code's default.
- **Keeping the sandbox on and only fixing EPERM detection** leaves every test run one escalation prompt away, and escalation could not be answered in headless runs.
- **Running elemental's shell under bash instead of PowerShell** was measured and did not help: about the same tokens and slightly more steps.

## Consequences

- A host with no approval answerer refuses commands that rules and the read-only list do not allow. The evaluation overlay's `eval` preset sets the approval policy to `never`, which the policy reads as the user's choice, so evaluation runs execute shell commands outside the sandbox without prompts, as the Claude Code baseline runs with `bypassPermissions`.
- Persistent-shell tools do not consult the policy.
