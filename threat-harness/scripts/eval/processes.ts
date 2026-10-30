/**
 * Which processes the file-finding evaluation stops after an agent run: the
 * ones an agent left running inside its task workspace. Pure; the runner lists
 * processes and kills what this returns.
 */

/** One row of the Windows process listing. */
export interface ProcessRow {
  readonly ProcessId: number
  readonly ParentProcessId: number
  readonly CommandLine: string | null
}

/** More matches than this means the match is wrong, not that an agent left that much behind. */
const MAX_LEFTOVER_PROCESSES = 40

/**
 * Processes to stop for a workspace: those whose command line names the workspace
 * directory (with either separator), never the runner itself or its ancestors.
 * @param rows - the process listing.
 * @param workspace - an absolute workspace path, at least three segments deep.
 * @param self - the runner's own process id.
 * @returns process ids, or none when the workspace path is too short to be specific
 *   or the match is implausibly broad.
 */
export function workspaceProcessIds(rows: readonly ProcessRow[], workspace: string, self: number): number[] {
  const forward = workspace.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  if (forward.split('/').filter(Boolean).length < 3) return []
  const names = [forward, forward.replaceAll('/', '\\')]
  const parent = new Map(rows.map(row => [row.ProcessId, row.ParentProcessId]))
  const protectedIds = new Set<number>()
  for (let id: number | undefined = self; id !== undefined && id !== 0 && !protectedIds.has(id); id = parent.get(id)) protectedIds.add(id)
  const matches = rows.filter((row) => {
    const command = row.CommandLine?.toLowerCase()
    if (command === undefined || protectedIds.has(row.ProcessId)) return false
    // The path must end at a separator, quote, space, or the end, so `…-ab12` does not match `…-ab123`.
    return names.some(name => new RegExp(`${escapeRegExp(name)}(?=$|[\\\\/"' ])`).test(command))
  })
  return matches.length > MAX_LEFTOVER_PROCESSES ? [] : matches.map(row => row.ProcessId)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
