/**
 * Shared rendering helpers for the shell tools (`tool-bash`,
 * `tool-pwsh`): the exit-status marker contract the tools' renderers emit,
 * Host `presentResult` implementations parse here, and the Web terminal card
 * model mirrors without importing Host code.
 * @module @elemental/shell/render
 */

/**
 * How both shell tools' prompt sections tell the model to triage a failed command: chase
 * failures its own change could cause, and report rather than repair an environment it was not
 * asked to fix. Unrelated failures otherwise turn a finished task into a run of check variants
 * and dependency repairs (file-finding evaluation, 2026-10-20).
 */
export const FAILURE_TRIAGE_GUIDANCE = 'Investigate a failure your work could have caused before moving on. '
  + 'A failure with a cause outside your change — the project was never built, a script does not exist, '
  + 'a command times out, installed dependencies are broken — describes the environment, not your task: '
  + 'unless the user asked for it, do not repair dependencies, build outputs, or toolchains, and do not cycle '
  + 'through variants of the same check. Say in your final answer what you could not verify and why, then '
  + 'continue with the checks that do work.'

/**
 * The exit status recovered from a rendered result, with the output body that
 * status was split off from.
 */
export type ParsedExitStatus =
  & { body: string }
  & ({ exitCode: number } | { signal: string })

/**
 * Split a rendered shell-tool result string into its output body and the
 * structured exit status — the inverse of the `[exit code: N]` /
 * `[killed by signal: X]` markers the shell tools' renderers append. A killed
 * marker yields `signal`; otherwise a non-zero marker yields `exitCode`;
 * absent both means a clean exit 0.
 *
 * The consumed marker is removed from `body` because a terminal presentation
 * shows the exit status as its own pill: leaving the marker in the output
 * would render the exit twice. Other markers (timeout, sandbox denial) carry
 * facts no pill shows, so they stay in the body.
 *
 * Replay only retains the rendered content text, not the original
 * `ShellRunResult`, so terminal presentation must recover the exit pill here.
 * Requiring a leading newline and the end of the string keeps ordinary output
 * that merely ends with marker-like text from matching unless the final line
 * is indistinguishable from a real marker.
 * @param text - rendered model-facing shell-tool result.
 * @returns the marker-free body plus the recovered terminal exit code or signal.
 */
export function parseExitStatus(text: string): ParsedExitStatus {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}
