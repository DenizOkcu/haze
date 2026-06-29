# tests/AGENTS.md

Vitest test suite instructions.

## General rules

- Tests are TypeScript and run with Vitest.
- Keep tests deterministic, isolated, and independent of the real user home/config whenever possible.
- Use temporary directories for filesystem/session/settings tests and restore cwd/env after each test.
- Do not read real `~/.haze/settings.json` or print secrets.
- Prefer focused unit tests for pure helpers and integration-style tests only where module boundaries matter.
- When changing public user-visible text, update tests intentionally rather than loosening assertions too far.

## Test organization

- `tests/cli/**` covers slash commands, chat helpers, streaming helpers, formatters, wizards, and headless command behavior.
- `tests/config/**` covers settings, providers, context files, LSP/MCP/skill settings, input history, update checks.
- `tests/core/**` covers agent compaction/request assembly/events/work state, output reducers, safety, session store, tasks, subagents, validation parser.
- `tests/hazeTools/**` covers built-in tool behavior exposed from `src/llm/hazeTools.ts` and `src/llm/tools/**`.
- `tests/llm/**` covers client/prompt/request context/LSP/MCP/web fetch/tool helper behavior.
- `tests/skills/**` covers skill loader/registry/tool/builder.
- `tests/ui/**` covers input buffer and Markdown rendering.
- `tests/utils/**` covers shared utilities.

## Common validation commands

```bash
npm test -- tests/path/to/file.test.ts
npm test -- tests/hazeTools/editFile.test.ts
npm test
npm run typecheck
```

## Mocking and isolation

- Use Vitest mocks/spies sparingly and restore them.
- Prefer real temp files for file-tool behavior; mock network/model providers.
- For child-process behavior, avoid brittle exact shell output where platform differences are possible.
- Keep snapshots small and meaningful; assert structured fields directly where possible.

## Adding tests

- Add regression tests for bug fixes before or alongside code changes.
- Cover both success and recoverable failure paths for tools.
- If a result object includes recovery hints/handles/reduction metadata, assert the fields that are part of the contract.
