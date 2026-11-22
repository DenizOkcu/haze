# Vendored grammar assets

- `web-tree-sitter.wasm` — core runtime from the npm package `web-tree-sitter` (MIT).
- `tree-sitter-javascript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-typescript.wasm`
  — byte-identical to the WASM files shipped by the npm package
  `@vscode/tree-sitter-wasm` (MIT; VS Code's grammar builds).
- All other `tree-sitter-*.wasm` (python, go, rust, java, c, cpp, c_sharp, ruby,
  php, kotlin, lua, bash) — from the npm package `tree-sitter-wasm` (MIT),
  `out/<language>/tree-sitter-<language>.wasm`. The underlying grammars are
  from the tree-sitter org projects (MIT).

Both grammar packages are pinned as devDependencies (`@vscode/tree-sitter-wasm`,
`tree-sitter-wasm`); the runtime (`src/core/graph/extract.ts`) pairs with
`web-tree-sitter@0.27.x`, which loads grammar WASMs of ABI 14/15.

Refresh by reinstalling the two devDependency packages and copying the files
over:

```bash
npm install
cp node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-{javascript,typescript,tsx}.wasm assets/graph-grammars/
for lang in python go rust java c cpp c_sharp ruby php kotlin lua bash; do
  cp "node_modules/tree-sitter-wasm/out/$lang/tree-sitter-$lang.wasm" assets/graph-grammars/
done
```

Adding a new language: copy its WASM from `tree-sitter-wasm` (pick an ABI 14/15
build), write a `LanguageProfile` under `src/core/graph/languages/`, register it
in `src/core/graph/languages/index.ts`, and bump `EXTRACTOR_VERSION`.

Do NOT vendor from `tree-sitter-wasms@0.1.13`: those emscripten side-module
builds are ABI 13/14-era and do not load on the `web-tree-sitter@0.27.x`
runtime (the 0.23.x runtime ABI is equally incompatible with these builds).
