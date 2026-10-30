/**
 * Checker-output parsing, introduced-diagnostic comparison, and the notice wording.
 */

import { describe, expect, it } from 'vitest'
import { formatDiagnosticNotice, introducedDiagnostics, parseDiagnostics } from '@elemental/edit-check'

describe('parseDiagnostics', () => {
  it('reads colon and tsc locations for the checked file, and skips other files and plain lines', () => {
    const output = [
      '/work/a.py:12:5: F821 Undefined name `x`',
      'a.py:3: E999 SyntaxError: invalid syntax\r',
      'src/a.py(7,2): error TS2322: Type string is not assignable to type number.',
      '-:1:1: W291 trailing whitespace',
      'other.py:1:1: F401 unused import',
      'Found 3 errors.',
      '',
    ].join('\n')
    expect(parseDiagnostics(output, '/work/a.py', '/work')).toEqual([
      { line: 12, message: 'F821 Undefined name `x`' },
      { line: 3, message: 'E999 SyntaxError: invalid syntax' },
      { line: 1, message: 'W291 trailing whitespace' },
    ])
    expect(parseDiagnostics(output, 'src/a.py', '/work')).toEqual([
      { line: 7, message: 'error TS2322: Type string is not assignable to type number.' },
      { line: 1, message: 'W291 trailing whitespace' },
    ])
  })
})

describe('introducedDiagnostics', () => {
  it('cancels each earlier diagnostic against one identical message, wherever its line moved', () => {
    const before = [{ line: 3, message: 'F821 Undefined name `x`' }]
    const after = [{ line: 5, message: 'F821 Undefined name `x`' }, { line: 9, message: 'F821 Undefined name `x`' }]
    expect(introducedDiagnostics(before, after)).toEqual([{ line: 9, message: 'F821 Undefined name `x`' }])
  })
})

describe('formatDiagnosticNotice', () => {
  it('words new and whole-file reports, and counts what it does not list', () => {
    expect(formatDiagnosticNotice('ruff', [{ line: 4, message: 'F821 Undefined name `x`' }], true, 3))
      .toBe('[Shadow check (ruff): this change introduced 1 diagnostic. L4: F821 Undefined name `x`.]')
    const three = [1, 2, 3].map(line => ({ line, message: 'E1 bad' }))
    expect(formatDiagnosticNotice('tsc', three, false, 2))
      .toBe('[Shadow check (tsc): the file has 3 diagnostics after this change. L1: E1 bad; L2: E1 bad; and 1 more.]')
  })
})
