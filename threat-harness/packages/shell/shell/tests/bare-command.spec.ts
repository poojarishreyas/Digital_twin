/**
 * Recognizing bare file-reading and search commands, and capping their output.
 */

import { describe, expect, it } from 'vitest'
import { bareCommand, capBareOutput } from '@elemental/shell'

describe('bareCommand (bash)', () => {
  it.each([
    ['cat src/a.ts', 'cat', 'read'],
    ['head -n 50 "my file.txt"', 'head', 'read'],
    ['tail -n 20 log.txt', 'tail', 'read'],
    ['/usr/bin/cat a.ts', 'cat', 'read'],
    ['LC_ALL=C grep -rn "a|b" src', 'grep', 'search'],
    ['rg -n \'TODO|FIXME\' .', 'rg', 'search'],
    ['find . -name "*.ts"', 'find', 'search'],
    ['egrep x a', 'egrep', 'search'],
    ['fgrep x a', 'fgrep', 'search'],
    ['grep -r "${HOME}" .', 'grep', 'search'],
    ['cat a\\ b.txt', 'cat', 'read'],
  ])('recognizes %s', (command, name, kind) => {
    expect(bareCommand(command, 'bash')).toEqual({ name, kind })
  })

  it.each([
    ['cat a.ts | wc -l'],
    ['grep x a; echo done'],
    ['cat a && cat b'],
    ['cat a > b'],
    ['grep x < a'],
    ['cat $(ls)'],
    ['cat "$(ls)"'],
    ['cat `ls`'],
    ['echo "`ls`"'],
    ['(cat a)'],
    ['cat a\ncat b'],
    ['find . -name x -delete'],
    ['find . -exec rm {} +'],
    ['ls -la'],
    ['git grep x'],
    ['cat "unterminated'],
    ['FOO=1'],
    [''],
  ])('leaves %j alone', (command) => {
    expect(bareCommand(command, 'bash')).toBeUndefined()
  })
})

describe('bareCommand (pwsh)', () => {
  it('recognizes cmdlets and aliases case-insensitively, with backtick escapes', () => {
    expect(bareCommand('Get-Content .\\src\\a.ts', 'pwsh')).toEqual({ name: 'Get-Content', kind: 'read' })
    expect(bareCommand('get-childitem -Recurse -Filter *.ts', 'pwsh')).toEqual({ name: 'get-childitem', kind: 'search' })
    expect(bareCommand('sls "a`"b" .\\a.ts', 'pwsh')).toEqual({ name: 'sls', kind: 'search' })
    expect(bareCommand('C:\\tools\\gc a.ts', 'pwsh')).toEqual({ name: 'gc', kind: 'read' })
  })

  it('leaves pipelines, blocks, and other commands alone', () => {
    expect(bareCommand('Get-Content a.ts | Select-Object -First 5', 'pwsh')).toBeUndefined()
    expect(bareCommand('Get-ChildItem | ForEach-Object { $_.Name }', 'pwsh')).toBeUndefined()
    expect(bareCommand('gc $(Get-Location)', 'pwsh')).toBeUndefined()
    expect(bareCommand('Write-Output hi', 'pwsh')).toBeUndefined()
    expect(bareCommand('FOO=1 gc a', 'pwsh')).toBeUndefined()
  })
})

describe('capBareOutput', () => {
  const read = { name: 'cat', kind: 'read' as const }
  const search = { name: 'rg', kind: 'search' as const }

  it('returns output within the cap unchanged', () => {
    expect(capBareOutput('short\n[exit code: 0]', read, 100)).toBe('short\n[exit code: 0]')
  })

  it('keeps whole leading lines and the trailing status markers, and names the tool to use', () => {
    const text = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n[exit code: 1]`
    expect(capBareOutput(text, read, 20)).toBe('line 0\nline 1\n'
      + `[Output of \`cat\` capped at 14 of ${Buffer.byteLength(text)} bytes. Use the read tool to read files: it numbers lines, pages with offset and limit, and records the read that edit requires.]\n`
      + '[exit code: 1]')
    expect(capBareOutput(text.replace('\n[exit code: 1]', ''), search, 20)).toContain('Use the grep tool to search file contents and the glob tool to find files')
  })

  it('keeps the start of a first line longer than the cap, cut at a character', () => {
    expect(capBareOutput(`${'é'.repeat(10)}\nnext`, read, 5)).toMatch(/^éé\n\[Output of `cat` capped at 4 of 25 bytes\./u)
  })
})
