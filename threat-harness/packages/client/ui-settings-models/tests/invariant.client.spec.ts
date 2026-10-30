import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import * as ModelsInvariant from '@elemental/client-ui-settings-models/invariant'
import InvariantRegistry from '@elemental/invariants'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ModelsInvariant).await()).resolves.toBeDefined()
  })

  it('node-half apply is a no-op host placeholder', async () => {
    const { apply } = await import('@elemental/client-ui-settings-models')
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('renders null until the shell injects the section dependencies', () => {
    expect(ModelsSection({} as ModelsSectionProps)).toBeNull()
  })
})
