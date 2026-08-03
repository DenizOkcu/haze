# src/core/persistence/AGENTS.md

Last updated: 2026-08-03 for the complete 0.10.0 release.

Ordered, flushable append writers for durable state.

## Responsibilities

- `orderedFileWriter.ts` is a tiny promise-chain writer that preserves entry invocation order and exposes `flush()`/`close()`/`error()`.

## Contracts

- One writer per open file, not one global lock. Preserve invocation order so a later snapshot cannot reach disk before an earlier one.
- Capture the first error and rethrow it from `flush()`/`close()`; do not let later writes mask the original failure.
- Callers (`sessionRecorder`, `llmLog`) must `flush()` at turn end, session switch, log end, and shutdown, surfacing one concise persistence warning rather than crashing the active model turn.
- Combine with `config/privateStorage.ts` so durable writes are also private (`0600` files under `0700` dirs).

## Tests

Covered by `tests/core/sessionStore.test.ts`, `tests/cli/commands/streaming.test.ts`, and log tests.
