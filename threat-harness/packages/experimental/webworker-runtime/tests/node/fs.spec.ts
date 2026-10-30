/**
 * Behavioural check of this package's `node:fs` bridge over a real MemoryVfs:
 * encoding branches, Dirent, file descriptors, FileHandle append/replace semantics,
 * and Node's error codes.
 *
 * Every import resolves through `src/` so the harness and bridge share the same
 * module-level VFS slot. Mixing the bare package's built entry with `/src/*`
 * imports can create two slots, leaving the bridge with no mounted filesystem.
 */
import { expect, test } from 'vitest'
import { MemoryVfs } from '@elemental/experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@elemental/experimental-webworker-runtime/src/storage/active.ts'
import * as fs from '@elemental/experimental-webworker-runtime/src/node/builtin_modules/implemented/fs.ts'
import * as fsp from '@elemental/experimental-webworker-runtime/src/node/builtin_modules/implemented/fs/promises.ts'
import type { VfsBigIntStats, VfsMutationSink, VfsStats } from '@elemental/experimental-webworker-runtime/src/storage/types.ts'

let flushes = 0
const sink: VfsMutationSink = {
  record: () => {},
  flush: () => {
    flushes += 1
    return Promise.resolve()
  },
}
const vfs = new MemoryVfs({ sink })
setActiveVfs(vfs)

// Identity precondition: the bridge must read this exact mounted VFS; successful
// calls alone could come from another mounted instance.
fs.mkdirSync('/elemental/.probe', { recursive: true })
fs.writeFileSync('/elemental/.probe/instance', 'x')
if (!vfs.existsSync('/elemental/.probe/instance')) {
  throw new Error('fs-check: the fs bridge is not reading the VFS this harness mounted '
    + '(two module instances — check that every import resolves through src/)')
}
vfs.rmSync('/elemental/.probe', { recursive: true })

const check = (label: string, actual: unknown, expected: unknown): void => {
  const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(seen).toBe(wanted) })
}
const throws = (label: string, run: () => unknown, code: string): void => {
  let outcome: string
  try {
    run()
    outcome = 'did not throw'
  } catch (error) {
    outcome = (error as { code?: string }).code ?? (error as Error).message
  }
  test(label, () => { expect(outcome).toContain(code) })
}

fs.mkdirSync('/elemental/config', { recursive: true })
fs.writeFileSync('/elemental/config/cordis.yml', '- id: timer\n')
check('readFileSync utf8', fs.readFileSync('/elemental/config/cordis.yml', 'utf8'), '- id: timer\n')
check('readFileSync options object', fs.readFileSync('/elemental/config/cordis.yml', { encoding: 'utf8' }), '- id: timer\n')
check('readFileSync bytes length', (fs.readFileSync('/elemental/config/cordis.yml') as Uint8Array).byteLength, 12)
check('readFileSync is Buffer', Buffer.isBuffer(fs.readFileSync('/elemental/config/cordis.yml')), true)
check('existsSync true', fs.existsSync('/elemental/config/cordis.yml'), true)
check('existsSync false', fs.existsSync('/elemental/nope'), false)
check('statSync isFile', fs.statSync('/elemental/config/cordis.yml').isFile(), true)
check('statSync size', fs.statSync('/elemental/config/cordis.yml').size, 12)
check('statSync dir', fs.statSync('/elemental/config').isDirectory(), true)
check('realpathSync', fs.realpathSync('/elemental/config/../config/cordis.yml'), '/elemental/config/cordis.yml')

fs.appendFileSync('/elemental/config/cordis.yml', '- id: llm\n')
check('appendFileSync', fs.readFileSync('/elemental/config/cordis.yml', 'utf8'), '- id: timer\n- id: llm\n')

fs.mkdirSync('/elemental/config/agent-presets/standard', { recursive: true })
fs.writeFileSync('/elemental/config/agent-presets/standard/SKILL.md', '# skill\n')
check('readdirSync names', fs.readdirSync('/elemental/config'), ['agent-presets', 'cordis.yml'])
const entries = fs.readdirSync('/elemental/config', { withFileTypes: true }) as fs.Dirent[]
check('readdirSync withFileTypes', entries.map(entry => [entry.name, entry.isFile(), entry.isDirectory()]), [
  ['agent-presets', false, true],
  ['cordis.yml', true, false],
])
check('Dirent parentPath', entries[0]!.parentPath, '/elemental/config')

const temporary = fs.mkdtempSync('/elemental/tmp/run-')
check('mkdtempSync creates directory', fs.statSync(temporary).isDirectory(), true)
check('mkdtempSync unique', fs.mkdtempSync('/elemental/tmp/run-') === temporary, false)

throws('readFileSync missing', () => fs.readFileSync('/elemental/missing'), 'ENOENT')
throws('statSync missing', () => fs.statSync('/elemental/missing'), 'ENOENT')
throws('accessSync missing', () =>{  fs.accessSync('/elemental/missing') }, 'ENOENT')
throws('readdirSync missing', () => fs.readdirSync('/elemental/missing'), 'ENOENT')
const appendFd = fs.openSync('/elemental/log.jsonl', 'a')
fs.writeSync(appendFd, '{"a":1}\n')
fs.writeSync(appendFd, '{"a":2}\n')
fs.closeSync(appendFd)
check('append fd writes', fs.readFileSync('/elemental/log.jsonl', 'utf8'), '{"a":1}\n{"a":2}\n')

const readFd = fs.openSync('/elemental/log.jsonl', 'r')
const target = new Uint8Array(8)
check('readSync count', fs.readSync(readFd, target, 0, 8), 8)
check('readSync bytes', new TextDecoder().decode(target), '{"a":1}\n')
check('readSync continues', fs.readSync(readFd, target, 0, 8), 8)
check('readSync second line', new TextDecoder().decode(target), '{"a":2}\n')
check('readSync at eof', fs.readSync(readFd, target, 0, 8), 0)
fs.closeSync(readFd)
throws('closed fd', () => fs.readSync(readFd, target, 0, 8), 'EBADF')

const writeFd = fs.openSync('/elemental/truncated.txt', 'w')
fs.writeSync(writeFd, 'abc')
fs.closeSync(writeFd)
check('write fd truncates', fs.readFileSync('/elemental/truncated.txt', 'utf8'), 'abc')

fs.renameSync('/elemental/truncated.txt', '/elemental/renamed.txt')
check('renameSync moves', [fs.existsSync('/elemental/truncated.txt'), fs.readFileSync('/elemental/renamed.txt', 'utf8')], [false, 'abc'])
fs.rmSync('/elemental/renamed.txt')
check('rmSync removes', fs.existsSync('/elemental/renamed.txt'), false)

// A FileHandle opened for appending must append, not replace: the JSONL session
// log writes its header frame first and every batch after it through this path.
fs.writeFileSync('/elemental/log-handle.jsonl', 'header\n')
const appendHandle = await fsp.open('/elemental/log-handle.jsonl', 'a')
check('append handle sees the existing size', (await appendHandle.stat()).size, 7)
await appendHandle.writeFile('batch-1\n')
await appendHandle.sync()
check('handle.sync flushes the active VFS', flushes, 1)
await appendHandle.close()
const secondHandle = await fsp.open('/elemental/log-handle.jsonl', 'a')
await secondHandle.writeFile('batch-2\n')
await secondHandle.close()
check('handle.writeFile appends in append mode', fs.readFileSync('/elemental/log-handle.jsonl', 'utf8'), 'header\nbatch-1\nbatch-2\n')
const replaceHandle = await fsp.open('/elemental/log-handle.jsonl', 'w')
await replaceHandle.writeFile('replaced\n')
await replaceHandle.close()
check('handle.writeFile replaces without append mode', fs.readFileSync('/elemental/log-handle.jsonl', 'utf8'), 'replaced\n')
const truncHandle = await fsp.open('/elemental/log-handle.jsonl', 'r+')
await truncHandle.truncate(4)
await truncHandle.close()
check('handle.truncate cuts the tail', fs.readFileSync('/elemental/log-handle.jsonl', 'utf8'), 'repl')

check('promises.readFile', await fsp.readFile('/elemental/config/cordis.yml', 'utf8'), '- id: timer\n- id: llm\n')
await fsp.writeFile('/elemental/promise.txt', 'p')
check('promises.writeFile', fs.readFileSync('/elemental/promise.txt', 'utf8'), 'p')
check('promises.stat', (await fsp.stat('/elemental/promise.txt')).isFile(), true)
await fsp.cp('/elemental/config', '/elemental/config-copy')
check('promises.cp tree', await fsp.readFile('/elemental/config-copy/agent-presets/standard/SKILL.md', 'utf8'), '# skill\n')
await fsp.rm('/elemental/config-copy', { recursive: true })
check('promises.rm recursive', fs.existsSync('/elemental/config-copy'), false)

// ---------------------------------------------------------------------------
// The `{ bigint: true }` stats the filesystem service reads.
//
// `fs-local` stats EVERY target this way before it lists or reads: it masks
// `mode` with a BigInt literal and builds its version token from
// `dev:ino:size:mtimeNs:ctimeNs`. A number-valued `mode` here made that mask
// throw `Cannot mix BigInt and other types`, which the service reported as
// FS_IO_ERROR and skill discovery swallowed as "empty directory" — the worker
// booted with an empty skill catalog and no error anywhere.
// ---------------------------------------------------------------------------

const bigStats = (path: string): VfsBigIntStats => fs.statSync(path, { bigint: true }) as VfsBigIntStats

fs.writeFileSync('/elemental/versioned.txt', 'one')
{
  const stats = bigStats('/elemental/versioned.txt')
  check('bigint stat reports mode as a BigInt', typeof stats.mode, 'bigint')
  check('bigint mode masks to the creation-default file permission', Number(stats.mode & 0o777n), 0o644)
  check('bigint stat reports the identity fields the version token needs', [
    typeof stats.dev, typeof stats.ino, typeof stats.size, typeof stats.mtimeNs, typeof stats.ctimeNs,
  ], ['bigint', 'bigint', 'bigint', 'bigint', 'bigint'])
  check('bigint nanosecond time scales the millisecond time', stats.mtimeNs === stats.mtimeMs * 1_000_000n, true)
  check('bigint stat still answers the type predicates', [stats.isFile(), stats.isDirectory()], [true, false])
  check('plain stat keeps its number shape', typeof fs.statSync('/elemental/versioned.txt').mode, 'number')
}

{
  // Two writes inside one millisecond must not produce one version: the service's
  // stale-write guard compares these tokens.
  const token = (path: string): string => {
    const stats = bigStats(path)
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
  }
  const before = token('/elemental/versioned.txt')
  fs.writeFileSync('/elemental/versioned.txt', 'two')
  check('a rewrite changes the version token', token('/elemental/versioned.txt') !== before, true)
  check('an unchanged file keeps its version token', token('/elemental/versioned.txt'), token('/elemental/versioned.txt'))
}

{
  const first = bigStats('/elemental/versioned.txt').ino
  fs.writeFileSync('/elemental/versioned.txt', 'three')
  check('identity survives a write to the same path', String(bigStats('/elemental/versioned.txt').ino), String(first))
  fs.rmSync('/elemental/versioned.txt')
  fs.writeFileSync('/elemental/versioned.txt', 'four')
  check('a removed and recreated path reports a new identity', bigStats('/elemental/versioned.txt').ino !== first, true)
}

check('a directory reports the creation-default mode in the bigint shape', Number(bigStats('/elemental/config').mode & 0o777n), 0o755)

// ---------------------------------------------------------------------------
// Permission bits round-trip: creation takes the caller's mode, chmod changes
// it, stat reads back the stored value. credentials-local's owner-only
// check reads exactly this (writeFileAtomic writes `wx` + mode 600, renames
// into place, then the provider stats the result).
// ---------------------------------------------------------------------------

const plainMode = (path: string): number => (fs.statSync(path) as VfsStats).mode & 0o777

fs.writeFileSync('/elemental/secrets.tmp', 'k: v\n', { mode: 0o600, flag: 'wx' })
fs.renameSync('/elemental/secrets.tmp', '/elemental/secrets.yaml')
check('a wx write with mode 600 stats as 600 after rename', plainMode('/elemental/secrets.yaml'), 0o600)
fs.writeFileSync('/elemental/secrets.yaml', 'k: w\n')
check('a rewrite keeps the creation bits', plainMode('/elemental/secrets.yaml'), 0o600)
fs.chmodSync('/elemental/secrets.yaml', 0o640)
check('chmod reads back exactly what was set', plainMode('/elemental/secrets.yaml'), 0o640)
await fsp.chmod('/elemental/secrets.yaml', 0o600)
check('promises.chmod reads back through the bigint shape', Number(bigStats('/elemental/secrets.yaml').mode & 0o777n), 0o600)
fs.mkdirSync('/elemental/vault', { mode: 0o700 })
check('mkdir honours its mode option', plainMode('/elemental/vault'), 0o700)
check('promises.stat forwards the bigint option', typeof (await fsp.stat('/elemental/config', { bigint: true })).mode, 'bigint')
