import { describe, expect, it } from 'vitest'
import type { NpmPackageLock, RegistryIndex } from './benchmark-npm-resolution.ts'
import {
  assertDualElementalInstallLayout,
  buildDualElementalRegistry,
} from './verify-npm-install-layout.ts'

function validLayout(): NpmPackageLock {
  return {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@elemental/elemental': '0.2.0', 'elemental-previous': 'npm:@elemental/elemental@0.1.0' } },
      'node_modules/@elemental/cordis': { version: '4.0.1' },
      'node_modules/@elemental/elemental': {
        version: '0.2.0',
        dependencies: { '@elemental/child': '^0.2.0' },
        peerDependencies: { '@elemental/cordis': '^4.0.1' },
      },
      'node_modules/@elemental/child': {
        version: '0.2.0',
        dependencies: { '@elemental/leaf': '^0.2.0' },
      },
      'node_modules/@elemental/leaf': { version: '0.2.0' },
      'node_modules/elemental-previous': {
        name: '@elemental/elemental',
        version: '0.1.0',
        dependencies: { '@elemental/child': '^0.1.0' },
        peerDependencies: { '@elemental/cordis': '^4.0.1' },
      },
      'node_modules/elemental-previous/node_modules/@elemental/child': {
        version: '0.1.0',
        dependencies: { '@elemental/leaf': '^0.1.0' },
      },
      'node_modules/elemental-previous/node_modules/@elemental/leaf': { version: '0.1.0' },
    },
  }
}

describe('npm install layout verifier', () => {
  it('creates two incompatible versions of every Elemental package', () => {
    const index: RegistryIndex = new Map([
      ['@elemental/elemental', new Map([['0.1.1-rc.2', {
        name: '@elemental/elemental',
        version: '0.1.1-rc.2',
        dependencies: { '@elemental/child': '^0.1.1-rc.2' },
        peerDependencies: { '@elemental/cordis': '^4.0.1' },
      }]])],
      ['@elemental/child', new Map([['0.1.1-rc.2', {
        name: '@elemental/child',
        version: '0.1.1-rc.2',
      }]])],
      ['@elemental/cordis', new Map([['4.0.1', {
        name: '@elemental/cordis',
        version: '4.0.1',
      }]])],
    ])

    const dual = buildDualElementalRegistry(index, '0.1.1-rc.2')

    expect([...dual.get('@elemental/elemental')?.keys() ?? []]).toEqual(['0.1.0', '0.2.0'])
    expect(dual.get('@elemental/elemental')?.get('0.1.0')).toMatchObject({
      version: '0.1.0',
      dependencies: { '@elemental/child': '^0.1.0' },
      peerDependencies: { '@elemental/cordis': '^4.0.1' },
    })
    expect(dual.get('@elemental/elemental')?.get('0.2.0')).toMatchObject({
      version: '0.2.0',
      dependencies: { '@elemental/child': '^0.2.0' },
    })
    expect(dual.get('@elemental/cordis')).toBe(index.get('@elemental/cordis'))
  })

  it('accepts isolated Elemental releases with one shared Cordis installation', () => {
    expect(assertDualElementalInstallLayout(validLayout())).toEqual({
      elementalPackagesPerVersion: 3,
      checkedElementalEdges: 4,
    })
  })

  it('rejects an internal edge that crosses release versions', () => {
    const layout = validLayout()
    const packages = { ...layout.packages }
    Reflect.deleteProperty(packages, 'node_modules/elemental-previous/node_modules/@elemental/leaf')

    expect(() => assertDualElementalInstallLayout({ ...layout, packages })).toThrow(
      'node_modules/elemental-previous/node_modules/@elemental/child: dependencies '
      + '@elemental/leaf resolves to node_modules/@elemental/leaf@0.2.0, expected 0.1.0',
    )
  })

  it('rejects a second Cordis installation', () => {
    const layout = validLayout()
    const packages = {
      ...layout.packages,
      'node_modules/elemental-previous/node_modules/@elemental/cordis': { version: '4.0.1' },
    }

    expect(() => assertDualElementalInstallLayout({ ...layout, packages })).toThrow(
      'expected one shared @elemental/cordis',
    )
  })
})
