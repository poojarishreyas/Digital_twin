/** Package-owned filesystem event-data invariants. @module @elemental/fs/invariant */

import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'
import type { FsObservation, FsReadKnowledge, FsTarget } from './types.ts'

const PACKAGE_NAME = '@elemental/fs'

/** Cordis companion plugin name. */
export const name = 'fs-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Assert that an event carries a usable opaque target identity. */
function validateTarget(target: FsTarget, fail: (message: string) => never): void {
  if (target.targetKey.length === 0) fail('filesystem event targetKey must be non-empty')
  if (target.displayPath.length === 0) fail('filesystem event displayPath must be non-empty')
}

/** Assert that recorded knowledge cites evidence and that its spans index its text in order. */
function validateKnowledge(knowledge: FsReadKnowledge, fail: (message: string) => never): void {
  if (knowledge.evidence.length === 0) fail('fs/read-recorded knowledge must cite at least one evidence result')
  // Lines as the read tool numbers them: a trailing newline ends the last line rather than starting one.
  const lineCount = knowledge.text.length === 0 ? 0 : knowledge.text.replace(/\n$/u, '').split('\n').length
  let previous = 0
  for (const span of knowledge.seen) {
    const ordered = Number.isInteger(span.start) && Number.isInteger(span.end) && previous < span.start && span.start <= span.end
    if (!ordered || span.end > lineCount) {
      fail('fs/read-recorded seen spans must be ascending, non-overlapping integer spans within the text')
    }
    previous = span.end
  }
}

/** Install checks over the filesystem decision and observation event stream. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'fs/write-intent'
      && eventName !== 'fs/edit-intent'
      && eventName !== 'fs/observed'
      && eventName !== 'fs/read-recorded'
      && eventName !== 'fs/read-recall') return
    validateTarget(args[0] as FsTarget, fail)
    if (eventName === 'fs/read-recorded') validateKnowledge(args[1] as FsReadKnowledge, fail)
    if (eventName === 'fs/observed') {
      const observation = args[1] as FsObservation
      switch (observation.kind) {
        case 'present':
          if (observation.version.length === 0) fail('fs/observed present version must be non-empty')
          break
        case 'absent':
          break
        default:
          fail('fs/observed kind must be present or absent')
      }
    }
  }, { global: true })
}

/**
 * Register the filesystem invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
