/**
 * The identity, timestamp, link, mutation, and durability-sink guarantees
 * MemoryVfs owes its consumers, asserted directly rather than through the
 * `node:fs` bridge.
 *
 * `fs-local` builds a version token from `dev:ino:size:mtimeNs:ctimeNs` and
 * refuses a write whose token moved since it read. Two properties carry that:
 * `ino` identifies the entry at a path, and `mtimeMs` moves on every write. The
 * timestamp cases freeze the clock, because these writes are in memory and two
 * revisions routinely land in the same millisecond — a real-clock test passes
 * whether or not the strict increment exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsBigIntStats, VfsMutation, VfsMutationSink, VfsStats } from '../../src/storage/types.ts'

const identity = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).ino

const linkCount = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).nlink

const modified = (vfs: MemoryVfs, path: string): number => (vfs.statSync(path) as VfsStats).mtimeMs

afterEach(() => { vi.restoreAllMocks() })

describe('entry identity', () => {
  it('distinguishes paths and holds each identity across repeated stats', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/one.txt', 'one')
    vfs.seed('/elemental/two.txt', 'two')
    const first = identity(vfs, '/elemental/one.txt')
    expect(identity(vfs, '/elemental/two.txt')).not.toBe(first)
    expect(identity(vfs, '/elemental/one.txt')).toBe(first)
  })

  it('forgets the identities under a directory removed as a subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/skills/git/SKILL.md', '# git\n')
    const before = identity(vfs, '/elemental/skills/git/SKILL.md')
    vfs.rmSync('/elemental/skills', { recursive: true })
    vfs.seed('/elemental/skills/git/SKILL.md', '# git rebuilt\n')
    expect(identity(vfs, '/elemental/skills/git/SKILL.md')).not.toBe(before)
  })

  it('moves the source identity when a file replaces another path', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/from.txt', 'moved')
    vfs.seed('/elemental/to.txt', 'replaced')
    const [source, destination] = [identity(vfs, '/elemental/from.txt'), identity(vfs, '/elemental/to.txt')]
    vfs.renameSync('/elemental/from.txt', '/elemental/to.txt')
    const renamed = identity(vfs, '/elemental/to.txt')
    expect(vfs.readFileSync('/elemental/to.txt', 'utf8')).toBe('moved')
    expect([renamed === source, renamed === destination]).toEqual([true, false])
  })
})

describe('modification time', () => {
  it('hydrates explicit metadata without confusing timestamps with permission bits', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/restored', 'value', { mode: 0o600, mtimeMs: 1_600_000_000_000 })
    vfs.seedDirectory('/elemental/restored-directory', { mode: 0o700, mtimeMs: 1_600_000_000_001 })
    const stats = vfs.statSync('/elemental/restored') as VfsStats
    const directory = vfs.statSync('/elemental/restored-directory') as VfsStats
    expect([stats.mode & 0o777, stats.mtimeMs]).toEqual([0o600, 1_600_000_000_000])
    expect([directory.mode & 0o777, directory.mtimeMs]).toEqual([0o700, 1_600_000_000_001])
  })

  it('advances on every write even while the clock stands still', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/log.jsonl', 'first\n')
    const seeded = modified(vfs, '/elemental/log.jsonl')
    vfs.writeFileSync('/elemental/log.jsonl', 'second\n')
    const written = modified(vfs, '/elemental/log.jsonl')
    vfs.appendFileSync('/elemental/log.jsonl', 'third\n')
    const appended = modified(vfs, '/elemental/log.jsonl')
    vfs.truncateSync('/elemental/log.jsonl', 6)
    const truncated = modified(vfs, '/elemental/log.jsonl')
    expect([written > seeded, appended > written, truncated > appended]).toEqual([true, true, true])
    // One millisecond per revision: the increment is the minimum that separates
    // two tokens, not a coarser bump that would skew a real timestamp.
    expect(truncated - seeded).toBe(3)
  })

  it('takes the clock once the clock has passed the entry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/log.jsonl', 'first\n')
    clock.mockReturnValue(1_700_000_005_000)
    vfs.writeFileSync('/elemental/log.jsonl', 'second\n')
    expect(modified(vfs, '/elemental/log.jsonl')).toBe(1_700_000_005_000)
  })

  it('extends truncation with zero bytes', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/file', new Uint8Array([1, 2]))
    vfs.truncateSync('/elemental/file', 5)
    expect([...vfs.readFileSync('/elemental/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0])
    const handle = vfs.open('/elemental/file', 'r+')
    await handle.truncate(7)
    expect([...vfs.readFileSync('/elemental/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0, 0, 0])
  })

  it('advances a directory only when its immediate entry set changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/elemental/workspace')
    const empty = modified(vfs, '/elemental/workspace')
    vfs.writeFileSync('/elemental/workspace/file.txt', 'one')
    const created = modified(vfs, '/elemental/workspace')
    vfs.writeFileSync('/elemental/workspace/file.txt', 'two')
    const rewritten = modified(vfs, '/elemental/workspace')
    vfs.rmSync('/elemental/workspace/file.txt')
    const removed = modified(vfs, '/elemental/workspace')
    expect([created > empty, rewritten === created, removed > rewritten]).toEqual([true, true, true])
  })
})

describe('mutation publication', () => {
  it('publishes only committed runtime changes and keeps image seeding silent', () => {
    const vfs = new MemoryVfs()
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.seed('/elemental/seeded.txt', 'seeded')
    expect(mutations).toEqual([])
    vfs.writeFileSync('/elemental/seeded.txt', 'changed')
    vfs.mkdirSync('/elemental/created')
    vfs.chmodSync('/elemental/created', 0o700)
    vfs.renameSync('/elemental/seeded.txt', '/elemental/renamed.txt')
    vfs.rmSync('/elemental/created', { recursive: true })
    expect(mutations.map(mutation => ({
      kind: mutation.kind,
      path: mutation.path,
      ...mutation.kind === 'write' ? { entryChanged: mutation.entryChanged } : {},
      ...mutation.kind === 'chmod' ? { mode: mutation.mode } : {},
    }))).toEqual([
      { kind: 'write', path: '/elemental/seeded.txt', entryChanged: false },
      { kind: 'mkdir', path: '/elemental/created' },
      { kind: 'chmod', path: '/elemental/created', mode: 0o700 },
      { kind: 'remove', path: '/elemental/seeded.txt' },
      { kind: 'write', path: '/elemental/renamed.txt', entryChanged: true },
      { kind: 'remove', path: '/elemental/created' },
    ])
    const renamed = mutations[4]
    expect(renamed?.kind === 'write' && new TextDecoder().decode(renamed.bytes)).toBe('changed')
    expect(() => { vfs.writeFileSync('/missing/file', 'no') }).toThrow(/ENOENT/)
    expect(mutations).toHaveLength(6)
  })

  it('contains a faulty observer and lets disposal stop later notifications', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/elemental')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vfs.subscribe(() => { throw new Error('observer failed') })
    const seen: string[] = []
    const second = vfs.subscribe((mutation) => { seen.push(mutation.path) })
    vfs.writeFileSync('/elemental/one', '1')
    first()
    second()
    vfs.writeFileSync('/elemental/two', '2')
    expect(seen).toEqual(['/elemental/one'])
    expect(reported).toHaveBeenCalledOnce()
  })

  it('feeds the same complete mutations to a durable sink and live subscribers', async () => {
    const recorded: VfsMutation[] = []
    let flushes = 0
    const sink: VfsMutationSink = {
      record: (mutation) => { recorded.push(mutation) },
      flush: async () => { flushes += 1 },
    }
    const vfs = new MemoryVfs({ sink })
    vfs.seedDirectory('/elemental')
    const observed: VfsMutation[] = []
    vfs.subscribe((mutation) => { observed.push(mutation) })
    vfs.writeFileSync('/elemental/log', 'a')
    vfs.appendFileSync('/elemental/log', 'bc')
    await vfs.flush()
    expect(observed).toEqual(recorded)
    expect(observed[0]).toBe(recorded[0])
    expect(recorded[0]).toMatchObject({ kind: 'write', path: '/elemental/log', mode: 0o644, entryChanged: true })
    expect(recorded[1]).toMatchObject({ kind: 'write', path: '/elemental/log', mode: 0o644, entryChanged: false, appendedFrom: 1 })
    expect(recorded[1]?.kind === 'write' && new TextDecoder().decode(recorded[1].bytes)).toBe('abc')
    expect(flushes).toBe(1)
  })

  it('publishes descriptor writes at the file identity current path', () => {
    const mutations: VfsMutation[] = []
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/source', 'old')
    const descriptor = vfs.openFileSync('/elemental/source', 'r+')
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.renameSync('/elemental/source', '/elemental/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('new'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/elemental/destination'])
    expect(vfs.readFileSync('/elemental/destination', 'utf8')).toBe('new')
    vfs.unlinkSync('/elemental/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('detached'))
    expect(mutations).toEqual([])
    expect(new TextDecoder().decode(descriptor.read(0, descriptor.stat().size))).toBe('detached')
  })

  it('decomposes a directory rename into replayable destination state', () => {
    const recorded: VfsMutation[] = []
    const vfs = new MemoryVfs({
      sink: { record: (mutation) => { recorded.push(mutation) }, flush: () => Promise.resolve() },
    })
    vfs.seedDirectory('/elemental/staging/nested', { mode: 0o700 })
    vfs.seed('/elemental/staging/nested/file', 'value', { mode: 0o600 })
    vfs.renameSync('/elemental/staging', '/elemental/published')

    expect(recorded.map(mutation => [mutation.kind, mutation.path])).toEqual([
      ['remove', '/elemental/staging'],
      ['mkdir', '/elemental/published'],
      ['mkdir', '/elemental/published/nested'],
      ['write', '/elemental/published/nested/file'],
    ])
    expect(recorded[3]).toMatchObject({ kind: 'write', mode: 0o600, entryChanged: true })
    expect(recorded[3]?.kind === 'write' && new TextDecoder().decode(recorded[3].bytes)).toBe('value')
  })
})

describe('directory rename', () => {
  it('rejects file, non-empty directory, and missing-parent destinations before mutation', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/source/nested/file', 'source')
    vfs.seed('/elemental/file', 'destination')
    vfs.seed('/elemental/non-empty/child', 'destination')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    expect(() => { vfs.renameSync('/elemental/source', '/elemental/file') })
      .toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
    expect(() => { vfs.renameSync('/elemental/source', '/elemental/non-empty') })
      .toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }))
    expect(() => { vfs.renameSync('/elemental/source', '/missing/destination') })
      .toThrow(expect.objectContaining({ code: 'ENOENT' }))

    expect(vfs.readFileSync('/elemental/source/nested/file', 'utf8')).toBe('source')
    expect(vfs.readFileSync('/elemental/file', 'utf8')).toBe('destination')
    expect(vfs.readFileSync('/elemental/non-empty/child', 'utf8')).toBe('destination')
    expect(mutations).toEqual([])
  })

  it('replaces an empty directory with the source subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/elemental/source/nested', { mode: 0o700 })
    vfs.seed('/elemental/source/nested/file', 'source')
    vfs.seedDirectory('/elemental/destination', { mode: 0o711 })

    vfs.renameSync('/elemental/source', '/elemental/destination')

    expect(vfs.existsSync('/elemental/source')).toBe(false)
    expect(vfs.readFileSync('/elemental/destination/nested/file', 'utf8')).toBe('source')
    expect((vfs.statSync('/elemental/destination') as VfsStats).mode & 0o777).toBe(0o755)
    expect((vfs.statSync('/elemental/destination/nested') as VfsStats).mode & 0o777).toBe(0o700)
  })
})

describe('hard links', () => {
  it('shares identity, bytes, and mode until one name is removed', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/session.jsonl', 'committed\n')
    vfs.linkSync('/elemental/session.jsonl', '/elemental/session-latest.jsonl')
    vfs.linkSync('/elemental/session-latest.jsonl', '/elemental/session-archive.jsonl')
    expect(identity(vfs, '/elemental/session-latest.jsonl')).toBe(identity(vfs, '/elemental/session.jsonl'))
    expect(linkCount(vfs, '/elemental/session.jsonl')).toBe(3n)
    expect(vfs.readFileSync('/elemental/session-latest.jsonl', 'utf8')).toBe('committed\n')
    const changedPaths: string[] = []
    vfs.subscribe((mutation) => { changedPaths.push(mutation.path) })
    vfs.appendFileSync('/elemental/session.jsonl', 'appended\n')
    expect(changedPaths).toEqual([
      '/elemental/session.jsonl',
      '/elemental/session-latest.jsonl',
      '/elemental/session-archive.jsonl',
    ])
    expect(vfs.readFileSync('/elemental/session.jsonl', 'utf8')).toBe('committed\nappended\n')
    expect(vfs.readFileSync('/elemental/session-latest.jsonl', 'utf8')).toBe('committed\nappended\n')
    vfs.chmodSync('/elemental/session-latest.jsonl', 0o600)
    expect((vfs.statSync('/elemental/session.jsonl') as VfsStats).mode & 0o777).toBe(0o600)
    vfs.unlinkSync('/elemental/session-latest.jsonl')
    expect(linkCount(vfs, '/elemental/session.jsonl')).toBe(2n)
    vfs.unlinkSync('/elemental/session-archive.jsonl')
    expect(linkCount(vfs, '/elemental/session.jsonl')).toBe(1n)
    expect(vfs.readFileSync('/elemental/session.jsonl', 'utf8')).toBe('committed\nappended\n')
  })

  it('treats rename between names of the same node as a no-op', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/source', 'value')
    vfs.linkSync('/elemental/source', '/elemental/alias')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    vfs.renameSync('/elemental/source', '/elemental/alias')

    expect(vfs.readFileSync('/elemental/source', 'utf8')).toBe('value')
    expect(vfs.readFileSync('/elemental/alias', 'utf8')).toBe('value')
    expect(linkCount(vfs, '/elemental/source')).toBe(2n)
    expect(mutations).toEqual([])
  })

  it('retargets linked names through file replacement and directory moves', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/replacement', 'replacement')
    vfs.seed('/elemental/target', 'old')
    vfs.linkSync('/elemental/target', '/elemental/target-alias')
    const replaced = vfs.openFileSync('/elemental/target', 'r+')
    vfs.renameSync('/elemental/replacement', '/elemental/target')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    replaced.write(0, new TextEncoder().encode('changed'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/elemental/target-alias'])
    expect(vfs.readFileSync('/elemental/target', 'utf8')).toBe('replacement')
    expect(vfs.readFileSync('/elemental/target-alias', 'utf8')).toBe('changed')
    expect(linkCount(vfs, '/elemental/target-alias')).toBe(1n)

    vfs.seed('/elemental/tree/file', 'tree')
    vfs.linkSync('/elemental/tree/file', '/elemental/outside')
    const moved = vfs.openFileSync('/elemental/tree/file', 'r+')
    vfs.renameSync('/elemental/tree', '/elemental/moved')
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('moved'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/elemental/outside', '/elemental/moved/file'])
    expect(linkCount(vfs, '/elemental/moved/file')).toBe(2n)

    vfs.rmSync('/elemental/moved', { recursive: true })
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('kept!'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/elemental/outside'])
    expect(vfs.readFileSync('/elemental/outside', 'utf8')).toBe('kept!')
    expect(linkCount(vfs, '/elemental/outside')).toBe(1n)
  })

  it('rejects renaming a file over an existing directory', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/elemental/file', 'value')
    vfs.seedDirectory('/elemental/directory')
    expect(() => { vfs.renameSync('/elemental/file', '/elemental/directory') }).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(vfs.readFileSync('/elemental/file', 'utf8')).toBe('value')
    expect(vfs.statSync('/elemental/directory').isDirectory()).toBe(true)
  })
})
