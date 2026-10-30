import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@elemental/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@elemental/skill'
import * as SkillBadge from '@elemental/skill-badge'

describe('skill-badge', () => {
  it('registers and disposes the bundled badge skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillBadge)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'elemental-badge',
      description: 'Add the official “powered by Elemental Harness” badge to documents, pull requests, merge requests, and other content produced with Elemental Harness. Use whenever creating a pull request or merge request. Also use when the user asks for an Elemental Harness badge, powered-by-Elemental-Harness attribution, or a reusable Elemental Harness badge asset or snippet.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'elemental-badge',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('elemental-badge')
    expect(loaded?.content).toContain('Preserve the badge\'s 191×20 dimensions')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ships the official 1148×120 PNG unchanged', async () => {
    const image = await readFile(new URL('../assets/elemental-badge.png', import.meta.url))
    expect(image.readUInt32BE(16)).toBe(1148)
    expect(image.readUInt32BE(20)).toBe(120)
    expect(createHash('sha256').update(image).digest('hex')).toBe(
      '965e7e68db4eb672530e59d41967cf5aa68e9ff9a99a20a164216adea1d405c0',
    )
  })
})
