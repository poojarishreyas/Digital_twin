/**
 * Package-owned invariant companion for `@elemental/spill-policy`.
 * @module @elemental/spill-policy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'

const PACKAGE_NAME = '@elemental/spill-policy'

/** Cordis companion plugin name. */
export const name = 'spill-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package exposes no independent event sequence or mutable data relation
 * beyond contracts enforced at its owning seam.
 */
const install: InvariantInstaller = () => { }

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
