/**
 * Tests for the spilled-result preview: the plain head/tail form, and the diagnostic form that
 * lists matching lines from the omitted middle with their line numbers in the stored file.
 */

import { describe, expect, it } from 'vitest'
import { buildPreview, DEFAULT_DIAGNOSTIC_PATTERN, headTailPreview } from '@elemental/spill-policy'

const pattern = new RegExp(DEFAULT_DIAGNOSTIC_PATTERN, 'i')

/** `count` numbered filler lines, `line N ok`, starting at `first`. */
function filler(first: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${first + index} ok`)
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

describe('headTailPreview', () => {
  it('splits the budget between head and tail, head rounded up', () => {
    const preview = headTailPreview('abcdefghij', 5)
    expect(preview.text).toBe('abcij')
    expect(preview.omitted).toEqual({ kind: 'exact', count: 5 })
  })
})

describe('buildPreview', () => {
  it('is the plain preview without a diagnostic spec or with a zero budget', () => {
    const text = filler(1, 200).join('\n')
    expect(buildPreview(text, 300)).toEqual(headTailPreview(text, 300))
    expect(buildPreview(text, 300, { bytes: 0, pattern })).toEqual(headTailPreview(text, 300))
  })

  it('lists matching middle lines between head and tail, numbered by stored-file line', () => {
    const lines = filler(1, 300)
    lines[149] = 'src/auth.ts(12,5): error TS2322: Type string is not assignable to type number.'
    lines[199] = '    at login (src/auth.ts:12:5)'
    const text = lines.join('\n')
    const preview = buildPreview(text, 600, { bytes: 300, pattern })

    expect(preview.text.startsWith('line 1 ok\n')).toBe(true)
    expect(preview.text.endsWith('line 300 ok')).toBe(true)
    expect(preview.text).toContain('[Matching lines from the omitted middle; numbers are lines in the stored file:]\n'
      + 'L150: src/auth.ts(12,5): error TS2322: Type string is not assignable to type number.\n'
      + 'L200:     at login (src/auth.ts:12:5)\n\n')
    expect(bytes(preview.text)).toBeLessThanOrEqual(600)
    // Both ends snap to whole lines; the omission counts the bytes outside them.
    const head = preview.text.slice(0, preview.text.indexOf('\n[Matching'))
    const tail = preview.text.slice(preview.text.indexOf('\n\n', preview.text.indexOf('[Matching')) + 2)
    expect(head.endsWith(' ok\n')).toBe(true)
    expect(tail.startsWith('line ')).toBe(true)
    expect(text.startsWith(head) && text.endsWith(tail)).toBe(true)
    expect(preview.omitted).toEqual({ kind: 'exact', count: bytes(text) - bytes(head) - bytes(tail) })
  })

  it('falls back to the plain preview over the whole budget when nothing in the middle matches', () => {
    const lines = filler(1, 300)
    // A match inside the head is already visible and does not count.
    lines[0] = 'error: first line'
    const text = lines.join('\n')
    expect(buildPreview(text, 600, { bytes: 300, pattern })).toEqual(headTailPreview(text, 600))
  })

  it('falls back to the plain preview when head and tail already cover the text', () => {
    const text = 'error one\nerror two'
    expect(buildPreview(text, 600, { bytes: 300, pattern })).toEqual(headTailPreview(text, 600))
  })

  it('stops listing when the next line does not fit, and shortens a long line that partly fits', () => {
    const lines = filler(1, 400)
    for (const index of [100, 101, 102, 103, 104, 105]) lines[index] = `FAIL tests/case-${index}.spec.ts`
    lines[106] = `Error: ${'x'.repeat(500)}`
    const text = lines.join('\n')
    const preview = buildPreview(text, 400, { bytes: 250, pattern })
    const section = preview.text.slice(preview.text.indexOf('[Matching'), preview.text.lastIndexOf('\n\n'))
    expect(section).toContain('L101: FAIL tests/case-100.spec.ts')
    expect(section.split('\n').length).toBeGreaterThan(2)
    expect(bytes(preview.text)).toBeLessThanOrEqual(400)

    const long = filler(1, 400)
    long[200] = `Error: ${'y'.repeat(500)}`
    const cut = buildPreview(long.join('\n'), 400, { bytes: 250, pattern })
    expect(cut.text).toMatch(/L201: Error: y+…\n\n/u)
    expect(bytes(cut.text)).toBeLessThanOrEqual(400)
  })

  it('drops a long matching line whose shortened form would be too small to read', () => {
    const lines = filler(1, 400)
    lines[200] = `Error: ${'z'.repeat(500)}`
    const text = lines.join('\n')
    // 110 bytes leave about 26 bytes for the line after the header, label, and separators.
    const preview = buildPreview(text, 300, { bytes: 110, pattern })
    expect(preview).toEqual(headTailPreview(text, 300))
  })

  it('numbers lines from the start of the stored text and ignores carriage returns', () => {
    const lines = filler(1, 300)
    lines[149] = 'panic: runtime error: index out of range'
    const text = lines.join('\r\n')
    const preview = buildPreview(text, 600, { bytes: 300, pattern })
    expect(preview.text).toContain('L150: panic: runtime error: index out of range\n')
  })

  it('lists a match on the last line when the tail starts inside it', () => {
    const text = `${filler(1, 300).join('\n')}\nnpm ERR! code ELIFECYCLE ${'q'.repeat(40)}`
    const preview = buildPreview(text, 200, { bytes: 150, pattern })
    expect(preview.text).toContain('L301: npm ERR! code ELIFECYCLE')
  })

  it('never exceeds the budget across budgets, reservations, and line shapes', () => {
    const lines = filler(1, 500)
    for (let index = 7; index < 500; index += 37) lines[index] = `Error ${index}: ${'é'.repeat(index % 90)}`
    const text = lines.join('\n')
    for (let budget = 0; budget <= 1200; budget += 37) {
      for (const reserve of [1, 90, 150, 400]) {
        const preview = buildPreview(text, budget, { bytes: Math.min(reserve, budget), pattern })
        expect(bytes(preview.text)).toBeLessThanOrEqual(budget)
      }
    }
  })

  it('keeps a byte cut at an end with no line break, and sets the section apart from it', () => {
    const text = `${'a'.repeat(300)} error in the middle ${'b'.repeat(300)}`
    const preview = buildPreview(text, 400, { bytes: 200, pattern })
    expect(preview.text.startsWith(`${'a'.repeat(100)}\n\n[Matching`)).toBe(true)
    // The shortened line starts 40 characters before the match: 39 of the a's and the space.
    expect(preview.text).toContain(`\nL1: …${'a'.repeat(39)} error in the middle bbb`)
    expect(preview.text.endsWith(`…\n\n${'b'.repeat(100)}`)).toBe(true)
  })

  it('keeps a tail whose only line break ends it', () => {
    const lines = filler(1, 300)
    lines[150] = 'error: middle'
    const text = `${lines.join('\n')}\n${'c'.repeat(60)}\n`
    expect(buildPreview(text, 220, { bytes: 150, pattern }).text.endsWith(`\n\n${'c'.repeat(34)}\n`)).toBe(true)
  })

  it('shows only the section when the reservation takes the whole budget', () => {
    const lines = filler(1, 300)
    lines[150] = 'error: middle'
    const preview = buildPreview(lines.join('\n'), 150, { bytes: 150, pattern })
    expect(preview.text).toBe('[Matching lines from the omitted middle; numbers are lines in the stored file:]\nL151: error: middle\n\n')
  })
})
