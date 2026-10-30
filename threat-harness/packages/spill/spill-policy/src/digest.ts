/**
 * The bounded preview a spilled result keeps in context. The plain form is a
 * head and a tail. The diagnostic form, used when a tool has a diagnostic
 * budget, also lists the lines in the omitted middle that match a diagnostic
 * pattern (errors, failures, stack frames), each numbered by its line in the
 * stored file so the model can read around it with `offset`/`limit`.
 *
 * @module @elemental/spill-policy/digest
 */

import { TextRetainer } from '@elemental/output-retention'
import type { Omitted } from '@elemental/output-retention'

/** A built preview: the text kept in context and how many bytes of the original it leaves out. */
export interface Preview {
  /** The preview text. */
  text: string
  /** Bytes of the original that neither the head nor the tail kept. */
  omitted: Omitted
}

/** How the diagnostic section of a preview is selected and sized. */
export interface DiagnosticSpec {
  /** UTF-8 bytes reserved for the diagnostic section, including its header and separators. */
  bytes: number
  /** Matches a diagnostic line. Tested per line, so it must not be global or sticky. */
  pattern: RegExp
}

/** Header line of the diagnostic section. */
const DIAGNOSTIC_HEADER = '[Matching lines from the omitted middle; numbers are lines in the stored file:]'

/** A diagnostic line is shortened to this many bytes when it does not fit whole; shorter remainders end the section. */
const MIN_DIAGNOSTIC_LINE_BYTES = 24

/** A shortened diagnostic line starts this many characters before its match, so the match keeps some context. */
const MATCH_LEAD_CHARS = 40

/** Truncation mark for a shortened diagnostic line. */
const ELLIPSIS = '…'

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** The first `maxBytes` bytes of `text`, cut at a codepoint boundary. */
function headOf(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

/** The last `maxBytes` bytes of `text`, cut at a codepoint boundary. */
function tailOf(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

/** `head` up to and including its last line break, or all of it when it has none. */
function toLastLineBreak(head: string): string {
  const cut = head.lastIndexOf('\n')
  return cut === -1 ? head : head.slice(0, cut + 1)
}

/** `tail` after its first line break, or all of it when it has none or the break ends it. */
function fromFirstLineBreak(tail: string): string {
  const cut = tail.indexOf('\n')
  return cut === -1 || cut === tail.length - 1 ? tail : tail.slice(cut + 1)
}

/**
 * The plain preview: `budget` bytes split between the head (rounded up) and the tail.
 * @param text - the full result text.
 * @param budget - UTF-8 bytes the preview may use.
 * @returns the joined head and tail, and the bytes they leave out.
 */
export function headTailPreview(text: string, budget: number): Preview {
  const retainer = new TextRetainer({ kind: 'headTail', headBytes: Math.ceil(budget / 2), tailBytes: Math.floor(budget / 2) })
  retainer.push(text)
  const kept = retainer.finish()
  return { text: kept.text, omitted: kept.omittedBytes }
}

/**
 * Render the lines that overlap the omitted middle `[from, to)` (UTF-16 offsets) and match
 * `pattern`, within `budget` bytes including the header and the blank lines around the section.
 * @returns the header and entries, each ending in a line break, or `''` when no line matches or fits.
 */
function diagnosticSection(text: string, from: number, to: number, pattern: RegExp, budget: number): string {
  // The preview places the section as `\n\n<header>\n<entries…>\n\n`, at most five line breaks
  // around the header and entries; reserve those and the header first.
  let remaining = budget - byteLength(`\n\n${DIAGNOSTIC_HEADER}\n\n\n`)
  const entries: string[] = []
  let lineNumber = 1
  for (let start = 0; start < to;) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    if (end > from) {
      const line = text.slice(start, end).replace(/\r$/u, '')
      if (pattern.test(line)) {
        const label = `L${lineNumber}: `
        // Every entry but the first is preceded by a newline.
        const separator = entries.length === 0 ? 0 : 1
        const whole = byteLength(label) + byteLength(line) + separator
        if (whole <= remaining) {
          entries.push(label + line)
          remaining -= whole
        } else {
          // A long line keeps the stretch from just before its match, marked as cut on each side.
          const from = Math.max(0, line.search(pattern) - MATCH_LEAD_CHARS)
          const lead = from === 0 ? '' : ELLIPSIS
          const room = remaining - byteLength(label) - separator - byteLength(lead) - byteLength(ELLIPSIS)
          if (room < MIN_DIAGNOSTIC_LINE_BYTES) break
          entries.push(label + lead + headOf(line.slice(from), room) + ELLIPSIS)
          break
        }
      }
    }
    if (newline === -1) break
    start = newline + 1
    lineNumber += 1
  }
  if (entries.length === 0) return ''
  return `${DIAGNOSTIC_HEADER}\n${entries.join('\n')}\n`
}

/**
 * The preview a spilled result keeps in context. Without a diagnostic spec, or when nothing in
 * the omitted middle matches, it is the plain head/tail preview over the whole budget. Otherwise
 * the head and tail share the budget minus `diagnostic.bytes`, and the matching middle lines fill
 * the reserved bytes between them.
 * @param text - the full result text.
 * @param budget - UTF-8 bytes the preview may use.
 * @param diagnostic - the diagnostic section's size and pattern; omitted for the plain preview.
 * @returns the preview, never larger than `budget` bytes.
 */
export function buildPreview(text: string, budget: number, diagnostic?: DiagnosticSpec): Preview {
  if (diagnostic === undefined || diagnostic.bytes === 0) return headTailPreview(text, budget)
  const ends = Math.max(0, budget - diagnostic.bytes)
  const total = byteLength(text)
  const headBytes = Math.ceil(ends / 2)
  const tailBytes = Math.floor(ends / 2)
  // With nothing omitted between the two ends there is no middle to search.
  if (headBytes + tailBytes >= total) return headTailPreview(text, budget)
  // Snap both ends to whole lines, so every line shown is complete and the listed lines read in
  // context; an end with no line break keeps its byte cut.
  const head = toLastLineBreak(headOf(text, headBytes))
  const tail = fromFirstLineBreak(tailOf(text, tailBytes))
  const section = diagnosticSection(text, head.length, text.length - tail.length, diagnostic.pattern, diagnostic.bytes)
  if (section === '') return headTailPreview(text, budget)
  const omitted = total - byteLength(head) - byteLength(tail)
  // A blank line sets the section apart; a head already ending in a line break needs one more.
  const lead = head === '' ? '' : head.endsWith('\n') ? '\n' : '\n\n'
  return { text: `${head}${lead}${section}\n${tail}`, omitted: { kind: 'exact', count: omitted } }
}
