# tests/AGENTS.md

Last updated: 2026-08-19 for the 1.1.0 release.

Vitest test suite instructions.

## General rules

Current regression priorities:

- Cover explicit provider/model selection and discovery fallback, malformed settings errors, image/path mention parsing and read-only blessings, hard secret-file protection (read and mutation refusals, symlink evasion, bless-set override, grep exclusion globs, terminal `secret_file_protected` results, blocked-summary rendering), project-skill precedence/provenance/symlink isolation, lazy session materialization and empty-session filtering, session browsing/forking, static/dynamic transcript ordering and streamed Markdown roots, ordered edit-recovery state for fast providers, normalized recovery paths, one-step repeated-tool suppression, managed background-process cleanup, subagent/fleet isolation, LSP protocol isolation and forced teardown, shell classification-as-metadata, bounded process retained-pipe cleanup, sparse line-page index invalidation, malformed IPv6 fail-closed behavior, and byte-accurate fetch truncation.

- Tests are TypeScript and run with Vitest.
- Keep tests deterministic, isolated, and independent of the real user home/config whenever possible.
- Use temporary directories for filesystem/session/settings tests and restore cwd/env after each test.
- Do not read real `~/.haze/settings.json` or print secrets.
- Prefer focused unit tests for pure helpers and integration-style tests only where module boundaries matter.
- When changing public user-visible text, update tests intentionally rather than loosening assertions too far.

## Test organization

- `tests/cli/**` covers slash commands, chat helpers, static/dynamic transcript partitioning, streaming helpers, formatters, wizards, and headless command behavior.
- `tests/config/**` covers settings, providers, context files, LSP/MCP/skill settings, input history, update checks, private storage permissions, and endpoint security.
- `tests/core/**` covers agent compaction/request assembly/events/work state, bounded I/O and sparse line paging, output reducers, safety, session store, tasks, subagents, validation parser, and the bounded subprocess primitive.
- `tests/hazeTools/**` covers built-in tool behavior exposed from `src/llm/hazeTools.ts` and `src/llm/tools/**`.
- `tests/llm/**` covers client/prompt/request context/LSP/MCP/web fetch/tool helper behavior.
- `tests/skills/**` covers skill loader/registry/tool/builder, including project-over-global precedence, candidate retention, untrusted-content framing, and real-path confinement.
- `tests/ui/**` covers input buffer, Markdown rendering, stable root-level streamed Markdown chunks, the theme registry (folder↔registry parity, resolved `#rrggbb` palettes, fg/bg contrast, famous port colors), and the OSC terminal-default sequences.
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
- Prefer real temp files for file-tool behavior; mock network/model providers. Project-skill tests must use an explicit temporary workspace and must not depend on the repository's own `.haze` directory.
- For child-process behavior, avoid brittle exact shell output where platform differences are possible.
- Keep snapshots small and meaningful; assert structured fields directly where possible.

## Adding tests

- Add regression tests for bug fixes before or alongside code changes.
- Cover both success and recoverable failure paths for tools.
- If a result object includes recovery hints/handles/reduction metadata, assert the fields that are part of the contract.
