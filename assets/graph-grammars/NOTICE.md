# Vendored grammar assets

- `web-tree-sitter.wasm` — core runtime from the npm package `web-tree-sitter` (MIT).
- `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`
  — prebuilt grammars from the npm package `tree-sitter-wasms` (Unlicense);
  the underlying grammars are from the tree-sitter org projects (MIT).

Refresh by reinstalling `tree-sitter-wasms` and `web-tree-sitter` and copying
the files over. The runtime (`src/core/graph/extract.ts`) pairs with
`web-tree-sitter@0.23.x` — newer runtimes cannot load these grammar builds.
