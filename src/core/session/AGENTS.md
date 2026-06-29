# src/core/session/AGENTS.md

Durable session storage.

## Storage contract

- Sessions are JSONL files under `~/.haze/sessions/<cwd-hash>/<session-id>.jsonl` unless tests/CLI options pass another directory.
- Each non-empty line is one `SessionEntry` JSON object.
- Session IDs are timestamp-derived and filenames end with `.jsonl`.
- Workspace separation uses a hash of resolved cwd.

## Entry types

Current entry types are:

- `header` — session metadata.
- `ui_message` — display message history.
- `conversation_snapshot` — durable AI SDK `ModelMessage[]` conversation state.
- `work_state_snapshot` — structured work state.
- `event` — lightweight structured lifecycle/tool/message events.

Prefer additive changes to entry shapes. Be tolerant when reading older/corrupt files.

## Restore behavior

- `restoreConversation` and `restoreWorkState` return the latest snapshot of their type.
- Malformed JSONL lines are reported in `parseErrors` with 1-based line numbers; do not silently discard corruption.
- UI/headless callers decide how to surface parse errors.

## Tests

Update `tests/core/sessionStore.test.ts` for persistence, restore, malformed-line, cwd hashing, and formatting changes.
