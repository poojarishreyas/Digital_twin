import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import InvariantRegistry from '@elemental/invariants'
import * as ShellPermissionPolicyInvariant from '../src/invariant.ts'

describe('shell-permission-policy invariant companion', () => {
  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ShellPermissionPolicyInvariant)

    expect(() => {
      ctx.invariants.register('@elemental/shell-permission-policy', () => {})
    }).toThrow(/already registered/)
  })
})
