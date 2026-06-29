# src/utils/AGENTS.md

Small shared utilities.

## Rules

- Keep utilities dependency-light and side-effect-light.
- Do not put product policy here if it belongs in `config/`, `core/`, or `llm/`.
- Path helpers must preserve workspace confinement guarantees; changes can affect every file tool.
- Filesystem walking should continue skipping `.git` and `node_modules` where documented and should remain pagination-friendly.
- YAML helpers should preserve existing comments/format only if the caller explicitly depends on it; otherwise keep behavior simple and tested.

## Important files

- `path.ts` — workspace root/path resolution and confinement helpers.
- `fs.ts` — directory walking and filesystem helpers used by tools.
- `collections.ts` — small collection operations such as name-based upsert/find.
- `version.ts` — version loading/parsing helpers.
- `yaml.ts` — YAML read/write utilities.

## Tests

Update matching `tests/utils/*.test.ts`, especially path traversal and directory walking edge cases.
