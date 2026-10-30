/**
 * Enclosing declarations for search results: which function, method, class, or other named
 * declaration contains a given line, so a matched line can be shown under the signature it
 * belongs to instead of as a bare line number.
 * @module @elemental/tool-fs/src/scopes
 */

import { listDeclarations } from './read-fold.ts'
import { grammarForPath, SyntaxParsers } from './read-syntax.ts'

/** A named declaration and the lines it spans. */
export interface DeclarationScope {
  /** Dotted name, e.g. `Parser.parse`. */
  name: string
  /** 1-based line of the declaration's signature. */
  start: number
  /** 1-based last line of the declaration. */
  end: number
  /** The signature line's text, trimmed. */
  header: string
}

/** Parsers for callers outside this package's tools; created on first use. */
let parsers: SyntaxParsers | undefined

/**
 * Every named declaration in a source file, outer before inner. Function bodies are not
 * entered, so a function's locals are never its own scope.
 * @param path - the file's path; its extension selects the grammar.
 * @param text - the file's complete text.
 * @returns the declarations, or `undefined` when the language has no bundled grammar or the
 *   grammar fails to load.
 */
export async function declarationScopes(path: string, text: string): Promise<DeclarationScope[] | undefined> {
  const grammar = grammarForPath(path)
  if (grammar === undefined) return undefined
  parsers ??= new SyntaxParsers()
  let parsed
  try {
    parsed = await parsers.parse(grammar, text)
  } catch {
    return undefined
  }
  try {
    const lines = text.split('\n')
    return listDeclarations(parsed.root).map(declaration => ({
      name: declaration.qualifiedName,
      start: declaration.line,
      end: declaration.span.end,
      // Declarations come from this text, so their signature line exists.
      header: (lines[declaration.line - 1] as string).trim(),
    }))
  } finally {
    parsed.dispose()
  }
}

/**
 * The innermost declaration containing a line: among the scopes whose signature-to-end range
 * contains it, the one whose signature starts last.
 * @param scopes - the file's declarations.
 * @param line - a 1-based line number.
 * @returns the innermost scope, or `undefined` for a line outside every declaration.
 */
export function innermostScope(scopes: readonly DeclarationScope[], line: number): DeclarationScope | undefined {
  let found: DeclarationScope | undefined
  for (const scope of scopes) {
    if (scope.start <= line && line <= scope.end && (found === undefined || scope.start >= found.start)) found = scope
  }
  return found
}
