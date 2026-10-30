/**
 * Package-owned invariant companion for `@elemental/shell-permission-policy`.
 * @module @elemental/shell-permission-policy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'

const PACKAGE_NAME = '@elemental/shell-permission-policy'

/** Cordis companion plugin name. */
export const name = 'shell-permission-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each decision is computed from the settings section and
 * the call when the call runs, and the only records it leaves are the approval
 * audit pair, whose invariant `user-approval` owns.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
