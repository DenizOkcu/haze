# Vendored grammar assets

- `web-tree-sitter.wasm` — core runtime from the npm package `web-tree-sitter` (MIT).
- `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`
  — prebuilt grammars from the npm package `tree-sitter-wasms` (Unlicense);
  the underlying grammars are from the tree-sitter org projects (MIT).

Refresh by reinstalling `tree-sitter-wasms` and `web-tree-sitter` and copying
the files over. The runtime (`src/core/graph/extract.ts`) pairs with
`web-tree-sitter@0.27.x`. Grammar WASMs must be rebuilt against 0.27.x:

  1. Install the wasm-pack toolchain (`cargo install wasm-pack`).
  2. For each grammar repo (tree-sitter-javascript, tree-sitter-typescript,
     tree-sitter-tsx) run: `cargo xtask build-wasm --lib --release` from the
     monorepo root (or `cargo xtask build-wasm` in a single-grammar checkout).
  3. Copy the resulting `.wasm` files from `target/wasm32-wasip1/release/` into
     `assets/graph-grammars/`.

The 0.23.x runtime ABI is incompatible with 0.27.x — previously vendored
grammar builds cannot load on the newer runtime.

