# src/utils/AGENTS.md

Last updated: 2026-08-15 for the 0.11.0 release.

Small shared utilities.

## Rules

Maintainability focus:

- Prefer small single-purpose helpers reused from domain modules over generic utility abstractions that hide product policy.

- Keep utilities dependency-light and side-effect-light.
- Do not put product policy here if it belongs in `config/`, `core/`, or `llm/`.
- Path helpers must preserve workspace confinement guarantees; changes can affect every file tool.
- Filesystem walking should continue skipping `.git` and `node_modules` where documented and should remain pagination-friendly.
- YAML helpers should preserve existing comments/format only if the caller explicitly depends on it; otherwise keep behavior simple and tested.

## Important files

- `path.ts` — workspace root/path resolution and confinement helpers. `workspacePathKey` provides lexical identity for comparing model-supplied workspace paths without filesystem access. `assertRealPathInsideRoot(root, candidate)` and `assertPathInsideRoot` are the shared real-path confinement primitives reused by file tools, skills, LSP, and the skills registry; keep them generic and add domain wrappers in callers rather than duplicating prefix logic.
- `fs.ts` — directory walking and filesystem helpers used by tools.
- `buildInfo.ts` — embedded build provenance (`dist/buildInfo.json`), the runtime capability registry, checkout-mismatch detection, and verbose-version formatting. The default-path `readBuildInfo()` cache uses a three-state sentinel: `undefined` = not loaded yet, `null` = loaded and absent (cached miss), object = cached manifest. Do not collapse `undefined` and `null` — treating "not loaded" as a cached miss returns before ever reading the manifest (the 0.11.0 regression). `resetBuildInfoCache()` exists for tests.
- `collections.ts` — small collection operations such as name-based upsert/find.
- `version.ts` — cached package-version loading and dependency-free version comparison helpers.
- `utf8.ts` — shared UTF-8-safe prefix and rolling-tail byte truncation.
- `openPath.ts` — one platform opener for local paths and browser URLs.
- `yaml.ts` — YAML read/write utilities.

## Tests

Update matching `tests/utils/*.test.ts`, especially path traversal and directory walking edge cases.
