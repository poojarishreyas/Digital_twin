import { describe, expect, it } from 'vitest'
import { Context } from '@elemental/cordis'
import { FsTargetKey, FsVersion } from '@elemental/fs'
import type { FsTarget } from '@elemental/fs'
import * as FsInvariant from '@elemental/fs/invariant'
import InvariantRegistry from '@elemental/invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(FsInvariant)
  return ctx
}

const target = (key = 'file:1', displayPath = 'file.txt'): FsTarget => ({
  targetKey: FsTargetKey(key),
  displayPath,
})

describe('filesystem invariants', () => {
  it('accepts decision and observation events with usable identities', async () => {
    const ctx = await setup()
    await expect(ctx.waterfall(
      ctx as never, 'fs/write-intent', target(), undefined,
      () => Promise.resolve(undefined),
    )).resolves.toBeUndefined()
    await expect(ctx.waterfall(
      ctx as never, 'fs/edit-intent', target(), undefined,
      () => Promise.resolve(undefined),
    )).resolves.toBeUndefined()
    expect(() => {
      ctx.emit('fs/observed', target(), { kind: 'present', version: FsVersion('v1') }, undefined)
    }).not.toThrow()
    expect(() => { ctx.emit('fs/observed', target(), { kind: 'absent' }, undefined) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects empty target and version identities', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('fs/observed', target(''), { kind: 'present', version: FsVersion('v1') }, undefined)
    })
      .toThrow(/targetKey must be non-empty/)
    expect(() => {
      ctx.emit('fs/observed', target('file:1', ''), { kind: 'present', version: FsVersion('v1') }, undefined)
    })
      .toThrow(/displayPath must be non-empty/)
    expect(() => {
      ctx.emit('fs/observed', target(), { kind: 'present', version: FsVersion('') }, undefined)
    }).toThrow(/present version must be non-empty/)
    expect(() => {
      ctx.emit('fs/observed', target(), { kind: 'unknown' } as never, undefined)
    }).toThrow(/kind must be present or absent/)
  })

  it('accepts well-formed read knowledge and recall lookups', async () => {
    const ctx = await setup()
    const evidence = [{ callId: 'c1', text: 'shown' }]
    expect(() => {
      ctx.emit('fs/read-recorded', target(), { text: 'a\nb\n', seen: [{ start: 1, end: 1 }, { start: 2, end: 2 }], evidence }, undefined)
    }).not.toThrow()
    expect(() => { ctx.emit('fs/read-recorded', target(), { text: '', seen: [], evidence }, undefined) }).not.toThrow()
    await expect(ctx.waterfall(ctx as never, 'fs/read-recall', target(), undefined, () => Promise.resolve(undefined))).resolves.toBeUndefined()
  })

  it('rejects read knowledge without evidence or with spans that do not index its text in order', async () => {
    const ctx = await setup()
    const evidence = [{ callId: 'c1', text: 'shown' }]
    interface Knowledge { text: string; seen: { start: number; end: number }[]; evidence: { callId: string; text: string }[] }
    const record = (knowledge: Knowledge) => () => {
      ctx.emit('fs/read-recorded', target(), knowledge, undefined)
    }
    expect(record({ text: 'a\n', seen: [], evidence: [] })).toThrow(/must cite at least one evidence/)
    for (const seen of [
      [{ start: 1.5, end: 2 }],
      [{ start: 1, end: 1.5 }],
      [{ start: 2, end: 2 }, { start: 1, end: 1 }],
      [{ start: 2, end: 1 }],
      [{ start: 1, end: 3 }],
    ]) {
      expect(record({ text: 'a\nb\n', seen, evidence })).toThrow(/seen spans must be ascending/)
    }
    expect(() => {
      ctx.emit('fs/read-recorded', target(''), { text: '', seen: [], evidence }, undefined)
    }).toThrow(/targetKey must be non-empty/)
  })
})
