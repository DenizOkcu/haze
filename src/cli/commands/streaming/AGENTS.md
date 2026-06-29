# src/cli/commands/streaming/AGENTS.md

Helpers for `src/cli/commands/streaming.ts`.

## Purpose

This subtree keeps the main agent loop readable by isolating display, accounting, and per-turn helper logic.

- `assistantText.ts` sanitizes and filters streamed assistant fragments.
- `toolGroupRenderer.ts` groups native tool calls/results into compact UI messages and emits events/log entries.
- `toolResultState.ts` tracks mutating tool success/failure and edit-recovery state.
- `turnRuntime.ts` contains token/usage extraction, retry delays, context-file memory, abortable delay, and response metrics helpers.

## Contracts

- Keep helpers deterministic where possible. UI callbacks and logs should be injected, not imported from chat state.
- Assistant text filtering must avoid hiding substantive final answers while suppressing duplicated/empty/lead-in fragments around tool calls.
- Tool result state drives model constraints in `prepareStep`; changes here can alter autonomy behavior and must be tested.
- Token estimates are approximate display/control inputs, not billing truth. Preserve provider usage fields when available.
- Context files discovered from tool outputs should be remembered for the active turn only; durable context loading belongs in `config/contextFiles.ts`.

## Tests

Use/update:

- `tests/cli/streamingFragments.test.ts`
- `tests/cli/streamingHelpers.test.ts`
- `tests/cli/toolGroupCaption.test.ts`
- `tests/cli/toolResultState.test.ts`
- `tests/cli/turnRuntime.test.ts`
