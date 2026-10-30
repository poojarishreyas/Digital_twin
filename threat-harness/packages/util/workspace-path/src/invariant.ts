/**
 * Package-owned invariant companion for `@elemental/util-workspace-path`.
 * @module @elemental/util-workspace-path/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'

const PACKAGE_NAME = '@elemental/util-workspace-path'

/** Cordis companion plugin name. */
export const name = 'workspace-path-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this utility owns no mutable runtime relationship. */
const install: InvariantInstaller = () => { }

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
