/**
 * When a later call makes an earlier `read` result redundant, for the tool-result pruner's
 * superseded markers. A pointer or delta read refers back to earlier output, so only a full read
 * with identical arguments, or a whole-file `write`, replaces one.
 * @module @elemental/tool-fs/src/supersession
 */

import { sameArguments } from '@elemental/compaction-tool-result-pruner'
import type { ToolCallRecord } from '@elemental/compaction-tool-result-pruner'

/** The `file_path` argument of a parsed call, when it has a string one. */
function filePath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const path = (args as Record<string, unknown>)['file_path']
  return typeof path === 'string' ? path : undefined
}

/**
 * Whether `later` supersedes the earlier `read` result: a successful `write` of the same path, or
 * a successful `read` with identical arguments that returned file content rather than a pointer
 * or delta.
 * @param earlier - the earlier `read` call.
 * @param later - any later call.
 * @returns true when the earlier result no longer carries anything the later one does not.
 */
export function readSuperseded(earlier: ToolCallRecord, later: ToolCallRecord): boolean {
  if (later.isError) return false
  if (later.name === 'write') return filePath(earlier.args) !== undefined && filePath(earlier.args) === filePath(later.args)
  const text = later.content.map(block => block.type === 'text' ? block.text : '').join('')
  return later.name === 'read' && sameArguments(earlier.args, later.args) && text.startsWith('<path>')
}
