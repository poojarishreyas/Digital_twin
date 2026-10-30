/**
 * Edit recovery after an external change: when an edit fails because the file changed since the
 * reader's last read (a formatter, a hook, another process), show the reader exactly what changed
 * and mark the file read at its current content, so it can retry without another read.
 * @module @elemental/tool-fs/src/stale-edit
 */

import type { Context } from '@elemental/cordis'
import { FsError } from '@elemental/fs'
import type { FsTarget } from '@elemental/fs'
import type { ToolRunContext } from '@elemental/tools'
import { evidenceVisible, formatHunks, recallRead } from './read-recall.ts'

/** Bounds on the changes a stale-edit failure may describe. */
export interface StaleEditCaps {
  /** Most changed lines worth describing; a larger change needs a full re-read. */
  maxEdits: number
  /** Byte cap on the described changes. */
  maxBytes: number
  /** Files at or above this size are not loaded whole. */
  streamMinSize: number
}

/**
 * Build the failure for an edit whose observed version went stale, when the reader's knowledge can
 * bridge to the current content. On success it records the reader's new knowledge and current
 * version, so the retried edit's guard matches.
 * @param ctx - the plugin context providing `fs` and the `fs/*` events.
 * @param exec - the failed edit's execution.
 * @param target - the edited target.
 * @param caps - bounds on the described change.
 * @returns the failure to report, or `undefined` when the generic stale-version remedy applies.
 */
export async function staleEditFailure(
  ctx: Context,
  exec: ToolRunContext,
  target: FsTarget,
  caps: StaleEditCaps,
): Promise<FsError | undefined> {
  const session = exec.parent === undefined ? exec.agent?.session : undefined
  if (session === undefined) return undefined
  const known = await ctx.waterfall('fs/read-recall', target, exec, () => undefined)
  if (known === undefined || !evidenceVisible(session, known.evidence)) return undefined
  const info = await ctx.fs.stat(target, exec.signal)
  if (info?.type !== 'file' || info.size === undefined || info.size >= caps.streamMinSize) return undefined
  const text = await ctx.fs.readText(target, exec.signal)
  // A write between the two stats leaves no version that matches `text`.
  if ((await ctx.fs.stat(target, exec.signal))?.version !== info.version) return undefined
  const recalled = recallRead(known, text, [], caps.maxEdits)
  if (recalled === undefined) return undefined
  let message: string
  if (recalled.kind === 'unchanged') {
    message = `"${target.displayPath}" was rewritten since your last read but its content is identical, so the edit was not applied. Retry it as is.`
  } else {
    const block = formatHunks(recalled.hunks)
    if (Buffer.byteLength(block, 'utf8') > caps.maxBytes) return undefined
    ctx.emit('fs/read-recorded', target, { text, seen: recalled.next.seen, evidence: [...known.evidence, { callId: exec.callId, text: block }] }, exec)
    message = `"${target.displayPath}" changed since your last read, so the edit was not applied. The changes, numbered by current lines (everything else you read is unchanged):\n${block}\nYou now have the current content: retry the edit against it.`
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return new FsError(message, 'FS_STALE_VERSION')
}
