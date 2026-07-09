# src/core/session/AGENTS.md

Last updated: 2026-07-09 for the 0.8.0 release.

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
- `conversation_snapshot` — durable AI SDK `ModelMessage[]` conversation state, slimmed before write so large tool results become previews/metadata.
- `work_state_snapshot` — structured work state.
- `event` — lightweight structured lifecycle/tool/message events.

Prefer additive changes to entry shapes. Be tolerant when reading older/corrupt files.

## Size policy

- `appendSessionEntry` is the choke point for durable writes; keep session-size policy centralized there or in `sessionSlimming.ts`.
- Do not persist streaming `message_update` events by default. They are UI progress, not durable resume state.
- Keep completed messages, tool lifecycle events, work-state snapshots, and conversation snapshots useful for resume.
- Large persisted tool outputs/errors should be replaced with previews, byte counts, and omission metadata. Active in-memory model context can stay richer than the persisted JSONL audit trail.

## Restore behavior

Maintainability focus:

- Session parse errors should stay explicit and actionable; do not silently replace corrupted durable state with empty defaults.

- `restoreConversation` and `restoreWorkState` return the latest snapshot of their type.
- Malformed JSONL lines are reported in `parseErrors` with 1-based line numbers; do not silently discard corruption.
- UI/headless callers decide how to surface parse errors.

## Tests

Update `tests/core/sessionStore.test.ts` for persistence, restore, malformed-line, cwd hashing, session slimming, and formatting changes.
