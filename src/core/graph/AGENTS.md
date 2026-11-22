# AGENTS.md — src/core/graph

Native code-graph intelligence: a persistent, deterministic symbol graph of the
workspace (files, symbols, calls, imports, inheritance) built with tree-sitter
WASM, queried by the `graph*` tools (`src/llm/tools/graphTools.ts`) and `/graph`.

The graph is **language-agnostic**: extraction dispatches through per-language
profiles, so any language with a vendored grammar works end-to-end.

## Layout

- `model.ts` — graph document + in-memory index; `GRAPH_SCHEMA_VERSION` gates
  persisted-graph compatibility, `EXTRACTOR_VERSION` (in `extract.ts`) gates
  cache compatibility.
- `profile.ts` — the shared extraction contract: `FileExtraction` shape,
  `LanguageProfile` interface, and tree-walk helpers.
- `languages/` — one profile per language family plus `index.ts`, the single
  registry mapping file extensions → vendored grammar WASM + profile.
  Currently: ECMAScript (js/ts/tsx/jsx/mjs/cjs/mts/cts), Python, Go, Rust,
  Java, C, C++, C#, Ruby, PHP, Kotlin, Lua, Bash. Grammars are vendored in
  `assets/graph-grammars/` (shipped via package `files`; sources and refresh
  steps in `assets/graph-grammars/NOTICE.md`).
- `extract.ts` — parser management (web-tree-sitter 0.27.x, grammar WASM cache)
  and `extractFile()` dispatch; also `resolveImportSpecifier()`, which delegates
  to the source file's profile.
- `buildGraph.ts` — workspace walk (gitignore + secret-path confinement via the
  shared file-tool layers) and `resolveGraph()` cross-file resolution.
- `store.ts` — persistence under `~/.haze/graphs/<workspace-key>/` (graph.json,
  manifest signatures, content-hash extraction cache), shrink guard.
- `query.ts` — IDF scoring, per-term seed guarantee, hub-damped traversal,
  token-budgeted rendering, shortest path.
- `analyze.ts` — communities (label propagation), god nodes, import cycles
  (Tarjan SCC), blast radius, `/graph` report.
- `digest.ts` — bounded structure digest for LLM compaction prompts.

## Contracts

- Determinism first: no LLM, no network, no shell in the build path. Same tree,
  same graph.
- Bump `EXTRACTOR_VERSION` on **every** change to extraction/derivation logic —
  content-hash caches otherwise replay stale shapes (this bit us once already).
  Bump `GRAPH_SCHEMA_VERSION` when the persisted shape changes.
- Adding a language: vendor its ABI 14/15 grammar WASM into
  `assets/graph-grammars/` (see NOTICE.md — `tree-sitter-wasms@0.1.13` builds
  do NOT load on the 0.27.x runtime), add a `LanguageProfile` in `languages/`,
  register it in `languages/index.ts`, bump `EXTRACTOR_VERSION`, add tests in
  `tests/core/graph/languages.test.ts`.
- Extraction reads workspace files only through the shared safety layers:
  in-process gitignore, `.git`/`node_modules` skips, `secretPaths.ts` refusals.
  The graph must never read a file the file tools would refuse.
- Graph output is orientation and retrieval — never validation evidence, and
  never a substitute for a real check in the completion gate.
- Edge confidence is honest: `EXTRACTED` (explicit in source) vs `INFERRED`
  (resolved cross-file). Preserve the labels end-to-end into tool output.
- Unresolvable imports (package paths, namespaces, system includes) are recorded
  in the extraction but create no cross-file edge — never guess a target.
- Staleness must be visible: results annotate `graph.stale`, and the manifest
  signature check (`computeStaleness`) is the source of truth.
- No daemons: builds are explicit (`graphRebuild`, `/graph`) plus one non-blocking `ensureGraphInBackground()` at chat startup that creates or incrementally refreshes the graph on every start; queries are lazy.
- Tests live in `tests/core/graph/` (pure units + temp-dir store tests); the
  store is injectable via its `GraphStore` paths, so tests never touch
  `~/.haze`.
