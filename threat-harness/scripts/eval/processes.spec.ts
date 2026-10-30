import { describe, expect, it } from 'vitest'
import { workspaceProcessIds } from './processes.ts'
import type { ProcessRow } from './processes.ts'

const WORKSPACE = 'C:\\Users\\me\\AppData\\Local\\Temp\\elemental-eval-ab12'
const row = (ProcessId: number, ParentProcessId: number, CommandLine: string | null): ProcessRow =>
  ({ ProcessId, ParentProcessId, CommandLine })

describe('workspaceProcessIds', () => {
  it('matches only command lines naming the workspace, with either separator', () => {
    const rows = [
      row(1, 0, 'C:\\Windows\\explorer.exe'),
      row(2, 1, '"C:\\Program Files\\PowerShell\\pwsh.exe"'),
      row(3, 2, 'node C:\\Users\\me\\AppData\\Local\\Temp\\elemental-eval-ab12\\node_modules\\vitest\\vitest.mjs run'),
      row(4, 3, 'node "C:/Users/me/AppData/Local/Temp/elemental-eval-ab12/node_modules/.bin/tsx" x.ts'),
      row(5, 1, 'node C:\\Users\\me\\AppData\\Local\\Temp\\elemental-eval-ab123\\x.js'),
      row(6, 1, 'node C:\\Users\\me\\AppData\\Local\\Temp\\elemental-eval-ab12'),
      row(7, 1, null),
    ]
    expect(workspaceProcessIds(rows, WORKSPACE, 99)).toEqual([3, 4, 6])
  })

  it('never matches the runner or its ancestors', () => {
    const rows = [
      row(10, 0, `bash run-bench.sh ${WORKSPACE}`),
      row(11, 10, `node run-eval.ts ${WORKSPACE}`),
      row(12, 11, `node leftover ${WORKSPACE}\\a.js`),
    ]
    expect(workspaceProcessIds(rows, WORKSPACE, 11)).toEqual([12])
  })

  it('kills nothing for a short path or an implausibly broad match', () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index + 1, 0, `node ${WORKSPACE}\\${String(index)}.js`))
    expect(workspaceProcessIds(rows, WORKSPACE, 999)).toEqual([])
    expect(workspaceProcessIds([row(1, 0, 'C:\\x\\y')], 'C:\\', 999)).toEqual([])
    expect(workspaceProcessIds([row(1, 0, 'C:\\x\\y')], '', 999)).toEqual([])
  })
})
