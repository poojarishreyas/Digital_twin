/**
 * Package-owned invariant companion for `@elemental/experimental-webworker-packer`.
 * @module @elemental/experimental-webworker-packer/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'

const PACKAGE_NAME = '@elemental/experimental-webworker-packer'

/** Cordis companion plugin name. */
export const name = 'webworker-packer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a build-time pass with no
 * production event stream or mutable data; the pack's own gates (unresolvable
 * own requests, the all-or-nothing wrapper contract) fail the pack instead.
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
