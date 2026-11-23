# src/core/persistence/AGENTS.md

Ordered, flushable append writers and private-permission file writes for durable state.

## Responsibilities

- `orderedFileWriter.ts` is a tiny promise-chain writer that preserves entry invocation order and exposes `flush()`/`close()`/`error()`.
- `privateStorage.ts` is the single helper for `~/.haze` home-state writes: `0700` dirs, `0600` atomic/append files, and opportunistic tightening of pre-existing overly-broad modes. It depends only on Node and `core/paths.ts`, and it lives here (not in `config`) so sessions and logs never import `config` (ARCH-02); settings, auth, history and update state in `config` import it from here.

## Contracts

- One writer per open file, not one global lock. Preserve invocation order so a later snapshot cannot reach disk before an earlier one.
- Capture the first error and rethrow it from `flush()`/`close()`; do not let later writes mask the original failure.
- Callers (`sessionRecorder`, `llmLog`) must `flush()` at turn end, session switch, log end, and shutdown, surfacing one concise persistence warning rather than crashing the active model turn.
- Combine with `./privateStorage.ts` so durable writes are also private (`0600` files under `0700` dirs).

## Tests

Covered by `tests/core/sessionStore.test.ts`, `tests/cli/commands/streaming.test.ts`, `tests/core/persistence/privateStorage.test.ts`, and log tests.
