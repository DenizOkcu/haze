# src/AGENTS.md

Instructions for Haze source code.

## Architecture boundaries

- Keep business logic in `core/`, `config/`, `llm/`, `skills/`, or `utils/` unless it is inherently UI orchestration.
- Keep React/Ink rendering and interaction state in `cli/` and `ui/` only.
- Keep AI SDK tool definitions and model-facing schemas in `llm/`; keep provider/settings persistence in `config/`.
- Keep reusable pure logic small and exported where tests need direct coverage.

## TypeScript style

- ESM only; local imports must include `.js` even when importing `.ts`/`.tsx` sources.
- Prefer explicit narrow types at module boundaries and exported functions.
- Avoid adding process-global mutable state. If unavoidable, expose reset/clear helpers and cover them in tests.
- Prefer deterministic functions for core logic. Isolate filesystem, network, child-process, and terminal effects.

## Public behavior

- Treat anything surfaced through slash commands, tool result shapes, session files, settings files, skill format, or README as public contract.
- When changing public result objects, update formatters and tests that snapshot/inspect those fields.
- Keep error messages actionable: include recovery suggestions when the model can retry safely.

## Test mapping

- For `src/cli/**`, check `tests/cli/**`.
- For `src/config/**`, check `tests/config/**`.
- For `src/core/**`, check `tests/core/**`.
- For `src/llm/hazeTools.ts` and `src/llm/tools/**`, check `tests/hazeTools/**` and `tests/llm/**`.
- For `src/skills/**`, check `tests/skills/**`.
- For `src/ui/**`, check `tests/ui/**`.
- For `src/utils/**`, check `tests/utils/**`.
