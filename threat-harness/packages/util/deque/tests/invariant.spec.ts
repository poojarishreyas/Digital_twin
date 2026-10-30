import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import InvariantRegistry from '@elemental/invariants'
import * as DequeInvariant from '../src/invariant.ts'

describe('deque invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(DequeInvariant)

    expect(() => {
      ctx.invariants.register('@elemental/deque', () => { })
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
