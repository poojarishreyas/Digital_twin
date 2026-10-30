/**
 * REAL-composition tier (packages/AGENTS.md): boot the shell-permission Loader
 * fixture as a subprocess through the deployment app/boot path and assert the
 * model-visible results of a read-only, a denied, and an unapproved command run
 * through the platform shell tool.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@elemental/loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface CommandReport {
  isError: boolean
  text: string
}

describe('shell permission policy through a real Loader composition', () => {
  const processTimeoutMs = 90_000
  it('runs read-only commands, refuses denied ones, and refuses unapproved ones nobody can approve', async () => {
    let report: Record<'readOnly' | 'denied' | 'unapproved', CommandReport> | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'shell-permission loader smoke',
      tempDirPrefix: 'shell-permission-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'permission-loader-report.json'), 'utf8')) as typeof report
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report?.readOnly).toEqual({ isError: false, text: 'permission-ok\n' })
    expect(report?.denied.isError).toBe(true)
    expect(report?.denied.text).toMatch(/Permission denied: denied by rule (bash|pwsh)\(git push \*\)\./u)
    expect(report?.denied.text).toContain('Do not retry this command another way.')
    expect(report?.unapproved.isError).toBe(true)
    expect(report?.unapproved.text).toContain('This command needs the user\'s permission (no permission rule allows this command), but the call has no agent to ask through.')
  }, processTimeoutMs + 15_000)
})
