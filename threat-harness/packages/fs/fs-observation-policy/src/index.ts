/**
 * Event-only filesystem observation policy; it registers no service. A weak owner/target map
 * records every authoritative presence/absence observation and the reader's content knowledge,
 * single-slot intent listeners derive guards from that state, the recall slot returns the
 * knowledge, and the provider performs the atomic freshness/no-clobber check. Without this
 * plugin, tools retain the bare provider's unconditional mutation behavior and full reads. See
 * the package README for composition rules.
 * @module @elemental/fs-observation-policy
 */

import type { Context } from '@elemental/cordis'
import { FsError } from '@elemental/fs'
import type { FsObservation, FsReadKnowledge, FsTarget, FsVersion, FsWriteIntent } from '@elemental/fs'
import type { FsObservationActor } from './types.ts'

export type { FsObservationActor } from './types.ts'

/** One owner's record of one target: its latest observation and, after a read, what it was shown. */
interface ObservedFileState {
  observation?: FsObservation
  knowledge?: FsReadKnowledge
}

/**
 * Per-context observed-file state and the `fs/*` decisions over it. One
 * instance is created per `apply()` so disposal can drop all state for HMR.
 */
class ObservedStateGate {
  /**
   * Observed-file state, keyed first by the owner object (weakly held, so a
   * collected session frees its state and its file snapshots), then by
   * {@link FsTarget.targetKey}. An observation's presence is the
   * prior-observation record; its discriminant keeps confirmed absence distinct
   * from an unseen target.
   */
  private observed = new WeakMap<object, Map<string, ObservedFileState>>()

  /**
   * Derive the observed-state owner from the opaque event actor — normally the
   * active agent session. `undefined` when no owner can be derived (e.g. a
   * direct tool call with no agent); such calls read freely but cannot satisfy
   * the write/edit prior-observation policy.
   */
  private owner(actor: object | undefined): object | undefined {
    // tsgolint treats object as assignable to weak FsObservationActor, while tsc still requires the structural cast for property access.
    // See the analyzer-divergence consequence in .agents/notes/implemented/process/2026-07-29-oxlint-linter.md.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- The analyzers disagree on this weak type.
    return (actor as FsObservationActor | undefined)?.agent?.session
  }

  private get(owner: object, targetKey: string): FsObservation | undefined {
    return this.observed.get(owner)?.get(targetKey)?.observation
  }

  /** The owner's mutable state for `targetKey`, created on first use. */
  private state(owner: object, targetKey: string): ObservedFileState {
    let byTarget = this.observed.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.observed.set(owner, byTarget)
    }
    let state = byTarget.get(targetKey)
    if (!state) {
      state = {}
      byTarget.set(targetKey, state)
    }
    return state
  }

  /** Drop all recorded state (HMR safety / disposal). */
  clear(): void {
    this.observed = new WeakMap()
  }

  /**
   * Decide the write intent: unseen or confirmed absent ⇒ `createIfAbsent`;
   * confirmed present ⇒ `replaceIfVersion` at the observed version.
   */
  writeIntent(target: FsTarget, actor: object | undefined): FsWriteIntent {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }
      : { kind: 'createIfAbsent' }
  }

  /**
   * Decide the edit version guard: unseen rejects with `FS_NOT_OBSERVED`,
   * confirmed absence rejects with `FS_NOT_FOUND`, and presence supplies the
   * observed version as the CAS basis.
   */
  editIntent(target: FsTarget, actor: object | undefined): { version: FsVersion } {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    if (!owner || prior === undefined) {
      throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    }
    if (prior.kind === 'absent') {
      throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    return { version: prior.version }
  }

  /**
   * Record an authoritative present or absent observation for this owner and target. Absence
   * also discards the owner's content knowledge, since there is no content left to know.
   */
  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (!owner) return
    const state = this.state(owner, target.targetKey)
    state.observation = observation
    if (observation.kind === 'absent') delete state.knowledge
  }

  /** Replace the owner's content knowledge of the target. */
  record(target: FsTarget, knowledge: FsReadKnowledge, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (owner) this.state(owner, target.targetKey).knowledge = knowledge
  }

  /** The owner's content knowledge of the target, if any was recorded. */
  recall(target: FsTarget, actor: object | undefined): FsReadKnowledge | undefined {
    const owner = this.owner(actor)
    return owner ? this.observed.get(owner)?.get(target.targetKey)?.knowledge : undefined
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-observation-policy'

/**
 * Register the five `fs/*` listeners. No `inject` — this plugin reads no
 * services; it operates only on its own `WeakMap`. The waterfalls are unbound
 * (the tool dispatches them with no `this`), so the listeners take the raw
 * `(target, actor, next)` arguments.
 */
export function apply(ctx: Context): void {
  const gate = new ObservedStateGate()

  ctx.effect(() => () => {
    // Drop all recorded state on disposal so a reloaded plugin starts clean
    // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes the
    // release observable and immediate for tests.
    gate.clear()
  }, 'fs-observation-policy observed-state teardown')

  // fs/write-intent: occupy the single decision slot — do NOT call next().
  // Deferred through Promise.resolve().then so the declared Promise return type
  // holds (a throw rejects, never escapes synchronously through the waterfall).
  ctx.on('fs/write-intent', (target, actor) => Promise.resolve().then(() => gate.writeIntent(target, actor)))

  // fs/edit-intent: occupy the single decision slot — do not call next().
  ctx.on('fs/edit-intent', (target, actor) => Promise.resolve().then(() => gate.editIntent(target, actor)))

  // fs/observed must remain synchronous and non-throwing: emit does not await
  // promises, and successful mutations have already committed. WeakMap.set
  // satisfies that contract for both presence and absence.
  ctx.on('fs/observed', (target, observation, actor) => {
    gate.observe(target, observation, actor)
  })

  // fs/read-recorded has the same synchronous recorder contract as fs/observed.
  ctx.on('fs/read-recorded', (target, knowledge, actor) => {
    gate.record(target, knowledge, actor)
  })

  // fs/read-recall: occupy the single lookup slot — do not call next().
  ctx.on('fs/read-recall', (target, actor) => Promise.resolve(gate.recall(target, actor)))
}
