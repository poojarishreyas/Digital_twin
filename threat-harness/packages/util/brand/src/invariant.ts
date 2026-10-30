/**
 * Package-owned invariant companion for `@elemental/brand`.
 * @module @elemental/brand/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'

const PACKAGE_NAME = '@elemental/brand'

/** Cordis companion plugin name. */
export const name = 'brand-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this utility owns no event stream, shared identity, or mutable module state.
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
