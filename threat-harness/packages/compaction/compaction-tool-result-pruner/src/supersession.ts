/**
 * Helpers for tools that declare when a later call supersedes an earlier result.
 * @module @elemental/compaction-tool-result-pruner/src/supersession
 */

import type { SupersessionRule } from './types.ts'

/** JSON with object keys sorted at every depth, so argument order does not affect equality. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    // Object keys are distinct, so the comparison never ties.
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  // Parsed JSON holds only JSON scalars here, each of which stringifies.
  return String(JSON.stringify(value))
}

/**
 * Whether two parsed call arguments are the same JSON value, ignoring object key order.
 * @param a - one call's parsed arguments.
 * @param b - the other call's parsed arguments.
 * @returns true when both are defined and equal as JSON values.
 */
export function sameArguments(a: unknown, b: unknown): boolean {
  return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b)
}

/** One argument of a parsed call; an absent argument reads as `null`. */
function argument(args: unknown, key: string): unknown {
  return typeof args === 'object' && args !== null && Object.hasOwn(args, key) ? (args as Record<string, unknown>)[key] : null
}

/**
 * A rule under which a later successful call of the same tool supersedes an earlier one when the
 * calls agree on `keys` (absent counts as a value), or on all arguments when no keys are given.
 * @param keys - the arguments that identify a re-run, e.g. a command and its working directory.
 * @returns the rule to register for the tool.
 */
export function rerunOf(...keys: string[]): SupersessionRule {
  return (earlier, later) => {
    if (later.isError || later.name !== earlier.name) return false
    if (keys.length === 0) return sameArguments(earlier.args, later.args)
    return earlier.args !== undefined && later.args !== undefined
      && keys.every(key => canonicalJson(argument(earlier.args, key)) === canonicalJson(argument(later.args, key)))
  }
}
