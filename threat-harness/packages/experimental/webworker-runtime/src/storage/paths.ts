/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const ELEMENTAL_ROOT = '/elemental'

/** `$ELEMENTAL_HOME`: durable-state directory inside the image. */
export const ELEMENTAL_HOME = `${ELEMENTAL_ROOT}/home`

/** Flat, symlink-free package tree resolved by the worker module loader. */
export const ELEMENTAL_NODE_MODULES = `${ELEMENTAL_ROOT}/node_modules`

/** Directory holding the composed cordis.yml and the agent-preset tree. */
export const ELEMENTAL_CONFIG = `${ELEMENTAL_ROOT}/config`

/** Default (empty) workspace directory. */
export const ELEMENTAL_WORKSPACE = `${ELEMENTAL_ROOT}/workspace`

/** Temporary directory reported by `os.tmpdir()`. */
export const ELEMENTAL_TMP = `${ELEMENTAL_ROOT}/tmp`
