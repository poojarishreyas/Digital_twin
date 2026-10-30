---
description: "Permission policy for model-run shell commands, for users and maintainers configuring allow/ask/deny rules, the opt-in shell sandbox, and the approval prompt."
kind: "package-reference"
---

# @elemental/shell-permission-policy

## Summary

`shell-permission-policy` decides, before each `bash` or `pwsh` tool call runs, whether the command runs outside the OS sandbox, runs inside it, asks the user first, or is refused. By default shell commands run outside the sandbox: a command that permission rules or the built-in read-only list allow runs at once, and any other command asks the user, who can allow it once, allow it and save a rule for the workspace ("don't ask again"), or decline. Deny rules refuse a command anywhere; ask rules make it ask every time. Setting `sandbox.enabled` confines commands under the `workspace-write` preset instead, except commands matching `sandbox.excludedCommands`. The policy registers as `ctx.shellPermissionPolicy`; the shell tools consult it when it is composed and behave as before when it is not. File tools are unaffected: they keep the session's sandbox mode.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose it on the host plane next to the approval service and the sandbox stack. It requires `ctx.approval`; `ctx.settings` is optional and, when present, makes the rules editable and lets "don't ask again" save them.

```yaml
- id: shell-permission-policy
  name: '@elemental/shell-permission-policy'
  config:
    sandbox:
      enabled: false
      excludedCommands: []
    allow: ['bash(pnpm test *)']
    ask: ['bash(git push *)']
    deny: ['bash(rm -rf *)']
```

| Field | Default | Meaning |
|---|---|---|
| `sandbox.enabled` | `false` | Confine commands in the OS sandbox when the session mode is `workspace-write` |
| `sandbox.excludedCommands` | `[]` | Patterns (no tool name) that run outside the sandbox even when it is enabled |
| `allow` | `[]` | Rules that let a command run without asking |
| `ask` | `[]` | Rules that make a command ask every time, inside the sandbox too |
| `deny` | `[]` | Rules that refuse a command |

The same fields, plus `workspaces`, form the `shell-permissions` section of `~/.elemental/settings.yaml`; the configuration above is its base layer. "Don't ask again" writes `workspaces.<workspace root>.allow`. Rules are read on every call, so an edit applies to the next command. A malformed rule fails the configuration load or the settings write.

### Rules

A rule is `bash(<pattern>)` or `pwsh(<pattern>)` (`Bash(…)` and `PowerShell(…)` are accepted). A pattern is an exact command, a prefix written `<prefix>:*`, or a wildcard where `*` matches any text; a trailing ` *` also matches the bare prefix, so `git log *` matches `git log`. `\*` is a literal star. PowerShell patterns match case-insensitively.

A command line is split into simple commands at `&&`, `||`, `;`, `|`, newlines, and bash `&`. Any part a deny rule names denies the line; the line is allowed only when every part is allowed by a rule or is read-only; otherwise it asks. Allow rules see each part after safe environment assignments such as `CI=1` are dropped; deny and ask rules see it after every assignment and wrapper command (`timeout`, `env`, `nice`, `sudo`, `xargs`, …) is dropped, so a wrapper cannot slip past them. A line with command substitution, a subshell or PowerShell script block, a here-document, or a redirection to or from a file cannot be split: only a rule naming it as a whole decides it, and otherwise it asks without offering a rule.

### Where a command runs

| Session mode | `sandbox.enabled` | Runs | Asks when |
|---|---|---|---|
| `workspace-write` | `false` | outside the sandbox | no rule or read-only check allows it |
| `workspace-write` | `true` | inside, or outside for an excluded command | an ask rule names it; an excluded command asks as above |
| `read-only` | either | inside | an ask rule names it |
| `danger-full-access` | either | outside | no rule or read-only check allows it |

Under the approval policy `never`, no one is asked. When the user chose it, as in the Full access preset, an unapproved command runs. When delegation pinned it on a child agent, the command keeps the child's standing sandbox policy instead, so it runs confined unless the parent chose full access. A call that carries `sandbox_permissions` asks through the escalation prompt and only deny rules apply to it here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ShellPermissionPolicy`: settings section, `authorize()`, the approval prompt, and rule saving |
| [`src/rules.ts`](src/rules.ts) | Rule parsing, pattern matching, line evaluation, and sandbox exclusion |
| [`src/words.ts`](src/words.ts) | The words allow rules and deny/ask rules judge for one simple command |
| [`src/allowlist.ts`](src/allowlist.ts) | Read-only commands for bash and PowerShell |
| [`src/suggest.ts`](src/suggest.ts) | The allow rule offered for "don't ask again" |
| [`src/types.ts`](src/types.ts) | Rule, verdict, and settings types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion with no runtime invariant |

### Decision path

`authorize()` evaluates the line, refuses it on a deny verdict, and returns the standing policy for an escalating call. It then decides whether the call runs confined: confined calls return the standing policy after asking only for an ask rule; unconfined calls return the standing policy stamped `danger-full-access` after the verdict or the approval policy allows them. The shell tools pass the returned policy to the executor, whose `danger-full-access` path skips confinement.

### Suggested rules

A simple command whose first two words are a program and a plain lowercase subcommand gets `<program> <subcommand> *`; programs that run other programs (`sh`, `env`, `sudo`, `xargs`, …) and commands with an unsafe environment assignment get an exact rule. An explicit ask rule offers no rule, because it asks every time.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Shell subsystem reference](../../../docs/subsystems/shell.md) — the shell executor seam and the tools that consult this policy.
- [Approval subsystem reference](../../../docs/subsystems/approval.md) — the prompt, its outcomes, and `allowed-always`.
- [Sandbox subsystem reference](../../../docs/subsystems/sandbox.md) — sandbox modes, escalation, and denial markers.
- [Shell permission design Agent Note](../../../.agents/notes/implemented/feature/2026-10-20-shell-permission-policy.md) — why commands run outside the sandbox by default.
- [Shell group map](../README.md) — adjacent executors and tools.

-----

<a id="model-experience"></a>
## Model Experience

### Refused shell command

#### What the model sees

A refused `bash` or `pwsh` call returns an error tool result with one of these texts: `Permission denied: denied by rule <rule>. Do not retry this command another way.`, `The user declined to run this command. Do not retry it another way; ask the user how to proceed.`, `The permission request for this command was cancelled.`, `This command needs the user's permission (<reason>), but no one can approve it now.`, or `This command needs the user's permission (<reason>), but the call has no agent to ask through.` A command that runs returns its usual result.

#### Token effect

Conditional: one short error result replaces the command output only when a command is refused.

#### KV Cache effect

Append-only: the result is appended like any tool result and does not change earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Persistent shells are not covered** — `tool-bash-persistent` and `tool-pwsh-persistent` type commands into one long-lived shell that was confined when it started, and they do not consult this policy.
- **No answerer means no unapproved commands** — a host with no approval answerer refuses every command that rules or the read-only list do not allow.
- **Delegated children run unapproved commands confined** — their prompts are not routed to the parent's user.
- **Rules have no path scope** — a rule matches command text in any working directory; saved rules are kept per workspace root only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
