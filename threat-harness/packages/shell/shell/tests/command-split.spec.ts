/**
 * Splitting a command line into the simple commands it runs.
 */

import { describe, expect, it } from 'vitest'
import { splitCommand } from '@elemental/shell'

describe('splitCommand (bash)', () => {
  it.each([
    ['git status', [['git', 'status']]],
    ['npm run test -- --watch=false', [['npm', 'run', 'test', '--', '--watch=false']]],
    ['cd pkg && pnpm vitest run a.spec.ts', [['cd', 'pkg'], ['pnpm', 'vitest', 'run', 'a.spec.ts']]],
    ['make || echo failed; echo done', [['make'], ['echo', 'failed'], ['echo', 'done']]],
    ['git log --oneline | head -n 5', [['git', 'log', '--oneline'], ['head', '-n', '5']]],
    ['sleep 1 & echo started', [['sleep', '1'], ['echo', 'started']]],
    ['grep -rn "a && b" src', [['grep', '-rn', 'a && b', 'src']]],
    ['echo \'$(not run)\'', [['echo', '$(not run)']]],
    ['npx vitest run 2>&1 | tail -n 20', [['npx', 'vitest', 'run'], ['tail', '-n', '20']]],
    ['pnpm build >/dev/null 2>&1', [['pnpm', 'build']]],
    ['pnpm build > /dev/null', [['pnpm', 'build']]],
    ['FOO=1 node a.js', [['FOO=1', 'node', 'a.js']]],
    ['echo a\\ b', [['echo', 'a b']]],
    ['ls \\\n  -la', [['ls', '-la']]],
    ['git status;', [['git', 'status']]],
    ['ls \\\r\n  -la', [['ls', '-la']]],
    ['echo a\\', [['echo', 'a\\']]],
    ['echo x>/dev/null', [['echo', 'x']]],
    ['', []],
  ])('splits %j', (command, expected) => {
    expect(splitCommand(command, 'bash')).toEqual(expected)
  })

  it.each([
    ['echo $(whoami)'],
    ['echo "$(whoami)"'],
    ['echo `whoami`'],
    ['echo "`whoami`"'],
    ['(cd a && make)'],
    ['cat <<EOF\nx\nEOF'],
    ['grep x < input.txt'],
    ['echo x > out.txt'],
    ['echo x >> out.txt'],
    ['echo x >'],
    ['echo "unterminated'],
    ['cmd >&foo'],
    ['echo > > x'],
    ['echo >; ls'],
    ['echo > && ls'],
    ['echo x > out.txt && ls'],
  ])('refuses to judge %j', (command) => {
    expect(splitCommand(command, 'bash')).toBeUndefined()
  })
})

describe('splitCommand (pwsh)', () => {
  it.each([
    ['Get-ChildItem -Recurse', [['Get-ChildItem', '-Recurse']]],
    ['git status; git diff', [['git', 'status'], ['git', 'diff']]],
    ['npm test && echo ok', [['npm', 'test'], ['echo', 'ok']]],
    ['Get-Content a.ts | Select-Object -First 5', [['Get-Content', 'a.ts'], ['Select-Object', '-First', '5']]],
    ['& "C:\\Program Files\\nodejs\\node.exe" -v', [['C:\\Program Files\\nodejs\\node.exe', '-v']]],
    ['npm test *>$null', [['npm', 'test']]],
    ['npm test 2>&1', [['npm', 'test']]],
    ['echo a`"b', [['echo', 'a"b']]],
    ['echo a&b', [['echo', 'a&b']]],
  ])('splits %j', (command, expected) => {
    expect(splitCommand(command, 'pwsh')).toEqual(expected)
  })

  it.each([
    ['Get-ChildItem | ForEach-Object { $_.Name }'],
    ['(Get-Content a.ts)[1..5]'],
    ['echo $(Get-Date)'],
    ['Get-Content a > b.txt'],
  ])('refuses to judge %j', (command) => {
    expect(splitCommand(command, 'pwsh')).toBeUndefined()
  })
})
