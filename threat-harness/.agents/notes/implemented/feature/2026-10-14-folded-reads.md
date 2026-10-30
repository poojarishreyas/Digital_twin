# Agent Note: Folded reads keep a file's outline around the requested code

Status: implemented

## Problem

`read` returned flat line ranges. To change one method in a 3,000-line file the model either read the whole file — about 34,000 tokens for `packages/typert/generator/src/analyzer.ts`, most of them bodies unrelated to the change — or read a narrow `offset`/`limit` window and lost sight of the imports, types, and neighbouring signatures it needed to write correct code. Claude Code and Codex share the same trade-off: line ranges or shell output, with nothing in between.

## Decision

`tool-fs` parses source files with `web-tree-sitter` and seven bundled WASM grammars (TypeScript, TSX, JavaScript, Python, Go, Rust, Java) and can return a folded view: the focus in full, and the rest of the file with every function, method, and closure body outside the focus replaced by one `⋯ [L<start>-L<end> folded: <n> lines]` marker between its signature line and its closing line. Comment and docstring runs of three or more lines outside the focus keep their first line with words. Imports, types, class fields, and constants are never folded. Visible lines keep their real numbers and text, so `edit` works on them unchanged.

The focus comes from one of two arguments:

- `symbol` names a declaration by dotted path or last segment. It always folds, whatever the file length. With `fold: false` it returns only the declaration's raw lines.
- `offset`/`limit` fold when the file has at least `readFoldMinLines` (default 400) lines and `readFoldWindows` (default `true`) is set.

A read with neither argument is unchanged. A read falls back to the plain window when the folded view would exceed `readMaxBytes`, when nothing outside the focus folds, or when the grammar cannot load (windowed reads only; a `symbol` read reports the failure). Streamed files never fold.

The fold planner (`read-fold.ts`) is grammar-agnostic. It reads only node types and the `body`, `name`, and `type` fields. A brace body keeps its `{` and `}` rows. An indentation block folds after the header's `:` and keeps a docstring's first line. An expression body keeps its last row, because that row can carry the enclosing call's tail, such as `}, [deps])`. One `Parser.init()` serves the process, because a second init would replace the WASM binding under parsers that already exist.

## Alternatives considered

**Language servers.** An LSP server gives exact symbols and types, but it starts slowly, needs a per-language install, and was removed from this harness for that reason. Tree-sitter parses in milliseconds from files the package ships with.

**Render folded bodies as `{ ... }` on the signature line (the design sketch's format).** Rejected because the rendered line would not match any line in the file, so the model could copy it into `edit` and fail. Keeping the real `}` line and a separate marker line keeps every numbered line exact.

**Fold whole classes outside the focus to one line.** Rejected because the method signatures inside them are what the model most often needs; classes keep their header and fields, and their methods fold individually.

**Grammar packages from npm (`tree-sitter-typescript` and the others).** Rejected because they ship native install scripts that this workspace's `allowBuilds` policy must review, and they bring `node-gyp` dependencies. The release WASM files are self-contained, so they are vendored with recorded hashes in `grammars/README.md`.

**Fold `offset`/`limit` reads off by default.** Not chosen, because the design calls for windowed reads to keep the outline. The cost is measured below, and `readFoldWindows: false` turns it off per deployment.

## Consequences

- On 1,900–4,100-line TypeScript, Python, and Go files, a `symbol` read costs 20–43% of the whole file (about 5,800–11,800 tokens), and every import, type, and signature stays visible. The design sketch estimated about 600 tokens for a 1,500-line file. That figure assumed types and signatures cost almost nothing, which is not true of real files.
- A folding `offset`/`limit` read costs much more than the bare window it replaces: a 60-line window of those files grew from about 600–1,000 tokens to 6,600–12,700. Paging through one file this way resends the outline with every page. Deduplicating that is the observation ledger's job.
- The package gains a `web-tree-sitter` runtime dependency and about 5.5 MB of grammar files. The first folded read pays for runtime initialization and grammar loading, about 50 ms. Parsing a 3,000-line file then takes a few tens of milliseconds.
- The `read` schema, system-prompt guidance, and tool description change, so every recorded session that pins them needs a snapshot refresh.

## Related

- [Spilled tool results keep a 2 KB preview](2026-09-29-spill-preview-size.md) — the earlier step in the same effort to cut the tokens that tool output leaves in context.
