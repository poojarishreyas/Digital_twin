# Bundled tree-sitter grammars

These WASM grammars back folded `read` views ([package README](../README.md#folded-reads)). They load with the `web-tree-sitter` runtime declared in `package.json`; every grammar here is ABI 14 or 15, which `web-tree-sitter` 0.25 accepts.

Each file is the unmodified release asset of the upstream grammar's tagged GitHub release, and each upstream project is MIT-licensed. [`LICENSES`](LICENSES) reproduces each upstream license text, which ships with the grammars as the MIT terms require.

| File | Upstream release | SHA-256 |
|---|---|---|
| `tree-sitter-typescript.wasm` | [tree-sitter/tree-sitter-typescript v0.23.2](https://github.com/tree-sitter/tree-sitter-typescript/releases/tag/v0.23.2) | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | [tree-sitter/tree-sitter-typescript v0.23.2](https://github.com/tree-sitter/tree-sitter-typescript/releases/tag/v0.23.2) | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |
| `tree-sitter-javascript.wasm` | [tree-sitter/tree-sitter-javascript v0.25.0](https://github.com/tree-sitter/tree-sitter-javascript/releases/tag/v0.25.0) | `5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240` |
| `tree-sitter-python.wasm` | [tree-sitter/tree-sitter-python v0.25.0](https://github.com/tree-sitter/tree-sitter-python/releases/tag/v0.25.0) | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-go.wasm` | [tree-sitter/tree-sitter-go v0.25.0](https://github.com/tree-sitter/tree-sitter-go/releases/tag/v0.25.0) | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `tree-sitter-rust.wasm` | [tree-sitter/tree-sitter-rust v0.24.0](https://github.com/tree-sitter/tree-sitter-rust/releases/tag/v0.24.0) | `44b8d1a2e307ee8933d7c0bcb6b0f30d56bc999999fd1d2d9608a7dcf6e8ce56` |
| `tree-sitter-java.wasm` | [tree-sitter/tree-sitter-java v0.23.5](https://github.com/tree-sitter/tree-sitter-java/releases/tag/v0.23.5) | `4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4` |

To update a grammar, download the `.wasm` asset of the new release, replace the file, update its row, and run the `read-elastic` spec: the fold planner reads node types and the `body`, `name`, and `type` fields, which upstream grammars occasionally rename.
