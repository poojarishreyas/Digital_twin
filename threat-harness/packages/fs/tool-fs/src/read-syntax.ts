/**
 * Lazy tree-sitter parsing for elastic reads. The WASM runtime initializes on first use and each
 * grammar loads once from the package's `grammars/` directory, so a deployment that never reads a
 * large source file never pays for either.
 * @module @elemental/tool-fs/src/read-syntax
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import type { SyntaxNode } from './read-fold.ts'

/** Grammar names bundled under `grammars/tree-sitter-<name>.wasm`. */
export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java'

/** Lowercased file extension (without the dot) to the bundled grammar that parses it. */
const GRAMMAR_BY_EXTENSION: Readonly<Record<string, GrammarName>> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
}

/** Extensions an elastic read supports, for model-facing errors. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(GRAMMAR_BY_EXTENSION).map(ext => `.${ext}`)

/**
 * The grammar that parses `path`, chosen by its extension.
 * @param path - the model-facing path the read reported.
 * @returns the bundled grammar name, or `undefined` when no bundled grammar covers the extension.
 */
export function grammarForPath(path: string): GrammarName | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(GRAMMAR_BY_EXTENSION, ext) ? GRAMMAR_BY_EXTENSION[ext] : undefined
}

/** A parsed file whose native tree memory the caller releases with `dispose`. */
export interface ParsedSource {
  /** The tree's root node. */
  root: SyntaxNode
  /** Free the WASM-side tree; the root and its nodes are unusable afterwards. */
  dispose(): void
}

/**
 * The tree-sitter WASM runtime is module-global: a second `Parser.init()` would replace the
 * binding under every parser already created, so all {@link SyntaxParsers} share one start. A
 * failed start stays failed for the process; windowed reads then fall back to plain lines.
 */
let runtime: Promise<void> | undefined

/** Directory holding the bundled grammar files, resolved through this package's own manifest. */
function grammarDirectory(): string {
  return join(dirname(createRequire(import.meta.url).resolve('@elemental/tool-fs/package.json')), 'grammars')
}

/**
 * One parser per grammar over the shared runtime, used by every `read` call of one plugin
 * instance. Parsing is synchronous once a grammar is loaded, so concurrent reads never
 * interleave on a parser.
 */
export class SyntaxParsers {
  private readonly parsers = new Map<GrammarName, Promise<Parser>>()

  /**
   * @param directory - where `tree-sitter-<name>.wasm` grammar files live; defaults to this package's `grammars/`.
   */
  constructor(private readonly directory: string = grammarDirectory()) {}

  /**
   * Parse `text` with the named grammar, loading the runtime and grammar on first use.
   * @param grammar - the bundled grammar to parse with.
   * @param text - the complete file text.
   * @returns the parsed tree; the caller must `dispose` it.
   */
  async parse(grammar: GrammarName, text: string): Promise<ParsedSource> {
    const parser = await this.parser(grammar)
    const tree = parser.parse(text)
    /* v8 ignore next -- `parse` yields null only for a cancelled or timed-out parse, and neither is configured here. */
    if (tree === null) throw new Error(`tree-sitter returned no tree for the ${grammar} grammar`)
    return { root: tree.rootNode, dispose: () => tree.delete() }
  }

  private parser(grammar: GrammarName): Promise<Parser> {
    let parser = this.parsers.get(grammar)
    if (parser === undefined) {
      parser = this.loadParser(grammar)
      // A failed load (missing or corrupt grammar file) retries on the next read instead of caching the failure.
      parser.catch(() => this.parsers.delete(grammar))
      this.parsers.set(grammar, parser)
    }
    return parser
  }

  private async loadParser(grammar: GrammarName): Promise<Parser> {
    runtime ??= Parser.init()
    await runtime
    const language = await Language.load(await readFile(join(this.directory, `tree-sitter-${grammar}.wasm`)))
    const parser = new Parser()
    parser.setLanguage(language)
    return parser
  }
}
