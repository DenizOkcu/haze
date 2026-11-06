# AGENTS.md — src/core/graph

Native code-graph intelligence: a persistent, deterministic symbol graph of the
workspace (files, symbols, calls, imports, inheritance) built with tree-sitter
WASM, queried by the `graph*` tools (`src/llm/tools/graphTools.ts`) and `/map`.

## Layout

- `model.ts` — graph document + in-memory index; `GRAPH_SCHEMA_VERSION` gates
  persisted-graph compatibility, `EXTRACTOR_VERSION` (in `extract.ts`) gates
  cache compatibility.
- `extract.ts` — pure per-file AST extraction (tree-sitter WASM; grammars
  vendored in `assets/graph-grammars/`, shipped via package `files`).
- `buildGraph.ts` — workspace walk (gitignore + secret-path confinement via the
  shared file-tool layers) and `resolveGraph()` cross-file resolution.
- `store.ts` — persistence under `~/.haze/graphs/<workspace-key>/` (graph.json,
  manifest signatures, content-hash extraction cache), shrink guard.
- `query.ts` — IDF scoring, per-term seed guarantee, hub-damped traversal,
  token-budgeted rendering, shortest path.
- `analyze.ts` — communities (label propagation), god nodes, import cycles
  (Tarjan SCC), blast radius, `/map` report.
- `digest.ts` — bounded structure digest for LLM compaction prompts.

## Contracts

- Determinism first: no LLM, no network, no shell in the build path. Same tree,
  same graph.
- Bump `EXTRACTOR_VERSION` on **every** change to extraction/derivation logic —
  content-hash caches otherwise replay stale shapes (this bit us once already).
  Bump `GRAPH_SCHEMA_VERSION` when the persisted shape changes.
- Extraction reads workspace files only through the shared safety layers:
  in-process gitignore, `.git`/`node_modules` skips, `secretPaths.ts` refusals.
  The graph must never read a file the file tools would refuse.
- Graph output is orientation and retrieval — never validation evidence, and
  never a substitute for a real check in the completion gate.
- Edge confidence is honest: `EXTRACTED` (explicit in source) vs `INFERRED`
  (resolved cross-file). Preserve the labels end-to-end into tool output.
- Staleness must be visible: results annotate `graph.stale`, and the manifest
  signature check (`computeStaleness`) is the source of truth.
- No daemons: builds are explicit (`graphRebuild`, `/map`); queries are lazy.
- web-tree-sitter must stay on the 0.23.x line — the vendored grammar builds
  (tree-sitter-wasms 0.1.13, emscripten side-modules) do not load on newer
  runtimes. See `assets/graph-grammars/NOTICE.md` for refresh instructions.
- Tests live in `tests/core/graph/` (pure units + temp-dir store tests); the
  store is injectable via its `GraphStore` paths, so tests never touch
  `~/.haze`.
