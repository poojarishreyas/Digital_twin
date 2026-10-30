/**
 * Pure elastic-read planning over a parsed syntax tree: which declarations a symbol names, and
 * which line runs fold away so that imports, types, signatures, and the focus stay visible.
 * The planner reads only node types, rows, and fields, so any tree-sitter grammar whose
 * function-like nodes expose a `body` field plugs in without per-language code.
 * @module @elemental/tool-fs/src/read-fold
 */

/** The subset of a tree-sitter node the planner reads; `web-tree-sitter`'s `Node` satisfies it. */
export interface SyntaxNode {
  /** Grammar node type, e.g. `function_declaration`; anonymous tokens use their literal text. */
  readonly type: string
  /** Source text the node spans. */
  readonly text: string
  /** Zero-based start row. */
  readonly startPosition: { readonly row: number }
  /** Zero-based end row and column; column 0 means the node ended on the previous row's newline. */
  readonly endPosition: { readonly row: number; readonly column: number }
  /** Named children in source order. */
  readonly namedChildren: readonly (SyntaxNode | null)[]
  /** First child, including anonymous tokens such as `{`. */
  readonly firstChild: SyntaxNode | null
  /** Last child, including anonymous tokens such as `}`. */
  readonly lastChild: SyntaxNode | null
  /** The parent node, or `null` at the root. */
  readonly parent: SyntaxNode | null
  /** The previous sibling including anonymous tokens such as `:`, or `null` for the first. */
  readonly previousSibling: SyntaxNode | null
  /** The previous named sibling, or `null` for the first. Nodes are fresh objects per access, so compare positions, never identity. */
  readonly previousNamedSibling: SyntaxNode | null
  /** All children, including anonymous tokens. */
  readonly children: readonly (SyntaxNode | null)[]
  /** Whether this node is an `ERROR` node: text the grammar could not place. */
  readonly isError: boolean
  /** Whether this node is a zero-width token the parser inserted to recover, such as a missing `}`. */
  readonly isMissing: boolean
  /** Whether this node or any descendant is an error or missing node. */
  readonly hasError: boolean
  /** The child stored under a grammar field such as `body` or `name`. */
  childForFieldName(fieldName: string): SyntaxNode | null
}

/** An inclusive, 1-based line span. */
export interface LineSpan {
  /** First line of the span. */
  start: number
  /** Last line of the span (inclusive). */
  end: number
}

/** Function-like node types across the bundled grammars; their `body` is what folds. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  // TypeScript / JavaScript
  'function_declaration', 'function_expression', 'function', 'generator_function_declaration',
  'generator_function', 'arrow_function', 'method_definition',
  // Python
  'function_definition',
  // Go / Java
  'method_declaration', 'func_literal', 'constructor_declaration', 'lambda_expression',
  // Rust
  'function_item', 'closure_expression',
])

/** Named declarations a `symbol` focus can address, beyond the named function-like nodes. */
const DECLARATION_TYPES: ReadonlySet<string> = new Set([
  ...FUNCTION_TYPES,
  'class_declaration', 'abstract_class_declaration', 'class_definition', 'class',
  'interface_declaration', 'enum_declaration', 'type_alias_declaration',
  'internal_module', 'module', 'variable_declarator', 'public_field_definition',
  'struct_item', 'enum_item', 'trait_item', 'mod_item', 'impl_item', 'type_spec',
])

/** Statement wrappers whose extent a focused declaration expands to (`export const f = …`). */
const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'export_statement', 'lexical_declaration', 'variable_declaration', 'decorated_definition',
  'ambient_declaration', 'type_declaration',
])

/** Comment node types across the bundled grammars. */
const COMMENT_TYPES: ReadonlySet<string> = new Set(['comment', 'line_comment', 'block_comment'])

/** Siblings that belong to the declaration after them: doc comments, decorators, attributes. */
const LEADING_TYPES: ReadonlySet<string> = new Set([...COMMENT_TYPES, 'decorator', 'attribute_item'])

/** A multi-line comment run of at least this many lines collapses to its summary line. */
const COMMENT_COLLAPSE_MIN_LINES = 3

/**
 * A hidden run shorter than this stays visible: its fold marker would cost as much as the line.
 * Two is the smallest run whose marker saves output.
 */
const MIN_FOLD_LINES = 2

/** Zero-based last row a node occupies; a node ending at column 0 ended on the prior newline. */
function endRow(node: SyntaxNode): number {
  const { row, column } = node.endPosition
  return column === 0 ? Math.max(node.startPosition.row, row - 1) : row
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null)
}

function intersects(startRow: number, lastRow: number, focus: readonly LineSpan[]): boolean {
  return focus.some(span => startRow + 1 <= span.end && lastRow + 1 >= span.start)
}

/** Whether a comment or docstring line carries words, as opposed to delimiters or rules like `# ====`. */
function hasContent(line: string): boolean {
  return /[\p{L}\p{N}]/u.test(line.trim().replace(/^[rRbBuUfF]{1,2}(?="""|''')/u, ''))
}

/** Zero-based [first, last] rows a function-like node's body hides, or `undefined` when it has no body. */
function bodyFoldRows(node: SyntaxNode): [number, number] | undefined {
  const body = node.childForFieldName('body')
  if (body === null) return undefined
  // A braced block keeps its `{` row and its `}` row.
  if (body.firstChild?.type === '{') return [body.startPosition.row + 1, endRow(body) - 1]
  if (body.type === 'block') {
    // An indentation block (Python) ends with its last statement, so everything after the
    // header's `:` folds, except a leading docstring's first line.
    const first = headerEndRow(body) + 1
    const docstring = named(body).find((child, index) => index === 0 && isDocstring(child))
    return [docstring === undefined ? first : Math.max(first, docstring.startPosition.row + 1), endRow(body)]
  }
  // An expression body keeps its last row, which may also carry the enclosing call's tail (`), [deps])`).
  return [Math.max(body.startPosition.row, node.startPosition.row + 1), endRow(body) - 1]
}

/** Row of the `:` that ends an indentation block's header, skipping comments between it and the block. */
function headerEndRow(body: SyntaxNode): number {
  let header = body.previousSibling
  /* v8 ignore next 2 -- an indentation block always follows its header's `:` token. */
  while (header !== null && COMMENT_TYPES.has(header.type)) header = header.previousSibling
  return header === null ? body.startPosition.row - 1 : endRow(header)
}

/** A bare string statement: a Python docstring. */
function isDocstring(node: SyntaxNode): boolean {
  return node.type === 'expression_statement' && named(node).map(child => child.type).join(' ') === 'string'
}

/** Comments and docstrings, which collapse to their summary line outside the focus. */
function isProse(node: SyntaxNode): boolean {
  return COMMENT_TYPES.has(node.type) || isDocstring(node)
}

/**
 * Plan the folds of an elastic view: every function-like body that does not touch the focus
 * hides (keeping its signature rows and closing row), and every multi-line comment run outside
 * the focus collapses to its first content line. Focus lines are never hidden.
 * @param root - the parsed file's root node.
 * @param lines - the file's lines, used to find a comment run's summary line.
 * @param focus - the 1-based line spans shown in full.
 * @returns ascending, non-overlapping hidden spans, each at least {@link MIN_FOLD_LINES} long.
 */
export function planFolds(root: SyntaxNode, lines: readonly string[], focus: readonly LineSpan[]): LineSpan[] {
  const hidden = new Uint8Array(lines.length)
  const hide = (firstRow: number, lastRow: number): void => {
    for (let row = Math.max(0, firstRow); row <= Math.min(lastRow, lines.length - 1); row += 1) hidden[row] = 1
  }

  const visit = (node: SyntaxNode): void => {
    if (FUNCTION_TYPES.has(node.type) && !intersects(node.startPosition.row, endRow(node), focus)) {
      const rows = bodyFoldRows(node)
      if (rows !== undefined && rows[1] - rows[0] + 1 >= MIN_FOLD_LINES) {
        hide(rows[0], rows[1])
        return
      }
    }
    collapseComments(named(node), lines, focus, hide)
    for (const child of named(node)) visit(child)
  }
  visit(root)

  const folds: LineSpan[] = []
  let row = 0
  while (row < hidden.length) {
    if (hidden[row] === 0) {
      row += 1
      continue
    }
    const start = row
    while (row < hidden.length && hidden[row] === 1) row += 1
    if (row - start >= MIN_FOLD_LINES) folds.push({ start: start + 1, end: row })
  }
  return folds
}

/**
 * Collapse each run of adjacent comment or docstring siblings outside the focus to its summary
 * line: the first line with words, or the run's last line when none has any.
 */
function collapseComments(
  children: readonly SyntaxNode[],
  lines: readonly string[],
  focus: readonly LineSpan[],
  hide: (firstRow: number, lastRow: number) => void,
): void {
  const runs: [number, number][] = []
  let run: [number, number] | undefined
  for (const child of children) {
    if (!isProse(child)) {
      run = undefined
    } else if (run !== undefined && child.startPosition.row <= run[1] + 1) {
      run[1] = endRow(child)
    } else {
      run = [child.startPosition.row, endRow(child)]
      runs.push(run)
    }
  }
  for (const [startRow, lastRow] of runs) {
    if (lastRow - startRow + 1 < COMMENT_COLLAPSE_MIN_LINES || intersects(startRow, lastRow, focus)) continue
    const offset = lines.slice(startRow, lastRow).findIndex(hasContent)
    const summary = offset === -1 ? lastRow : startRow + offset
    hide(startRow, summary - 1)
    hide(summary + 1, lastRow)
  }
}

/** A declaration the tree names, with its dotted path through enclosing named declarations. */
export interface Declaration {
  /** Dotted name, e.g. `Parser.parse`. */
  qualifiedName: string
  /** Lines the declaration occupies, widened to its statement wrapper and leading comments, decorators, and attributes. */
  span: LineSpan
  /** 1-based line where the declaration itself starts: its signature, after any leading comments and decorators. */
  line: number
}

function declarationName(node: SyntaxNode): string | undefined {
  if (!DECLARATION_TYPES.has(node.type)) return undefined
  // A Rust `impl Foo` names its target type; every other declaration names itself.
  const name = node.childForFieldName('name') ?? (node.type === 'impl_item' ? node.childForFieldName('type') : null)
  // `declare module 'x'` names itself with a string literal; the quotes are not part of the name.
  return name?.text.replace(/^(['"])(.*)\1$/su, '$2')
}

/** Widen a declaration to its statement wrapper, then back over adjacent leading siblings. */
function declarationSpan(node: SyntaxNode): LineSpan {
  let outer = node
  /* v8 ignore next -- the root is never a declaration, so the walk always has a parent to test. */
  while (outer.parent !== null && WRAPPER_TYPES.has(outer.parent.type)) outer = outer.parent
  let startRow = outer.startPosition.row
  for (let sibling = outer.previousNamedSibling; sibling !== null; sibling = sibling.previousNamedSibling) {
    if (!LEADING_TYPES.has(sibling.type) || endRow(sibling) < startRow - 1) break
    startRow = sibling.startPosition.row
  }
  return { start: startRow + 1, end: endRow(outer) + 1 }
}

/**
 * List every named declaration in source order with its dotted path. Function bodies are not
 * entered, so locals never shadow the file's own declarations.
 * @param root - the parsed file's root node.
 * @returns the declarations, outer before inner.
 */
export function listDeclarations(root: SyntaxNode): Declaration[] {
  const found: Declaration[] = []
  const visit = (node: SyntaxNode, scope: readonly string[]): void => {
    const name = declarationName(node)
    const inner = name === undefined ? scope : [...scope, name]
    if (name !== undefined) found.push({ qualifiedName: inner.join('.'), span: declarationSpan(node), line: node.startPosition.row + 1 })
    if (FUNCTION_TYPES.has(node.type)) return
    for (const child of named(node)) visit(child, inner)
  }
  visit(root, [])
  return found
}

/**
 * Resolve a model-supplied symbol to the declarations it names. An exact dotted path wins;
 * otherwise a trailing-segment match (`parse` finds `Parser.parse`) selects every candidate.
 * @param declarations - the file's declarations from {@link listDeclarations}.
 * @param symbol - the requested name, optionally dotted.
 * @returns the matched declarations in source order; empty when nothing matches.
 */
export function matchSymbol(declarations: readonly Declaration[], symbol: string): Declaration[] {
  const exact = declarations.filter(declaration => declaration.qualifiedName === symbol)
  if (exact.length > 0) return exact
  return declarations.filter(declaration => declaration.qualifiedName.endsWith(`.${symbol}`))
}
