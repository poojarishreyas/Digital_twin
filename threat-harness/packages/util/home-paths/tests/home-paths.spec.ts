import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ELEMENTAL_HOME_DISPLAY,
  ELEMENTAL_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultElementalHome,
  elementalHomeDisplay,
  elementalHomePath,
  expandHomePath,
  resolveElementalHome,
} from '@elemental/home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('elemental path helpers', () => {
  it('owns the shared default Elemental home directory name', () => {
    expect(ELEMENTAL_HOME_DIR_NAME).toBe('.elemental')
    expect(DEFAULT_ELEMENTAL_HOME_DISPLAY).toBe('~/.elemental')
    expect(defaultElementalHome()).toBe(join(homedir(), '.elemental'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.elemental')).toBe(join(homedir(), '.elemental'))
    expect(expandHomePath('~\\.elemental')).toBe(join(homedir(), '.elemental'))
    expect(expandHomePath('/tmp/.elemental')).toBe('/tmp/.elemental')
    expect(expandHomePath('~other/.elemental')).toBe('~other/.elemental')
  })

  it('resolves explicit path before ELEMENTAL_HOME and the default', () => {
    const envHome = join(homedir(), 'env-elemental')

    expect(resolveElementalHome('/tmp/explicit-elemental', { ELEMENTAL_HOME: '~/env-elemental' })).toBe(resolve('/tmp/explicit-elemental'))
    expect(resolveElementalHome(undefined, { ELEMENTAL_HOME: '~/env-elemental' })).toBe(envHome)
    expect(resolveElementalHome(undefined, {})).toBe(defaultElementalHome())
  })

  it('treats an empty or whitespace-only ELEMENTAL_HOME as unset', () => {
    expect(resolveElementalHome(undefined, { ELEMENTAL_HOME: '' })).toBe(defaultElementalHome())
    expect(resolveElementalHome(undefined, { ELEMENTAL_HOME: '   ' })).toBe(defaultElementalHome())
  })

  it('joins child segments onto the resolved ELEMENTAL_HOME', () => {
    vi.stubEnv('ELEMENTAL_HOME', '~/env-elemental')
    expect(elementalHomePath()).toBe(join(homedir(), 'env-elemental'))
    expect(elementalHomePath('storages', 'cache')).toBe(join(homedir(), 'env-elemental', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(elementalHomeDisplay(resolve(defaultElementalHome()))).toBe('~/.elemental')
    expect(elementalHomeDisplay('/some/other/root')).toBe('$ELEMENTAL_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elemental-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
