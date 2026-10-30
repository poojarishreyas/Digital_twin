/** Package-owned invariant companion. @module @elemental/api-session-controller/invariant */

/* jscpd:ignore-start */
import type { Context } from '@elemental/cordis'
import type { InvariantInstaller } from '@elemental/invariants'

const PACKAGE_NAME = '@elemental/api-session-controller'

/** Cordis companion plugin name. */
export const name = 'api-session-controller-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: every page and frame is checked against the addressed durable Session. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
