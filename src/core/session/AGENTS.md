# src/core/session/AGENTS.md

Last updated: 2026-08-19 for the 1.1.0 release.

Durable session storage.

## Storage contract

- Sessions are JSONL files under `~/.haze/sessions/<cwd-hash>/<session-id>.jsonl` unless tests/CLI options pass another directory. New sessions stay in memory until the first resumable message; empty sessions must not create files or appear in resume listings.
- Session files and their parent directories use private POSIX permissions (`0600`/`0700`) via `config/privateStorage.ts`. Writes are ordered and flushable: callers preserve append invocation order and `flush()` at turn end, session switch, and shutdown, surfacing one concise persistence warning on failure rather than swallowing it.
- Before the first non-empty UI message or non-empty conversation snapshot, prepared metadata may remain queued on the in-memory session object. Materialization writes the header, queued entries, and triggering message in invocation order. If the session stays empty, the queue is discarded with the process and no file is created.
- Each non-empty line is one `SessionEntry` JSON object.
- Session IDs use a lexicographically sortable timestamp plus a short random suffix so same-millisecond creation cannot collide; filenames end with `.jsonl`.
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
- User-attached image `file` parts (F03) are slimmed to a short text placeholder (filename, media type, byte count) so sessions never store image bytes. The placeholder is a valid text part, so resumed conversations stay protocol-safe for any provider.

## Restore behavior

Maintainability focus:

- Session parse errors should stay explicit and actionable; do not silently replace corrupted durable state with empty defaults.

- `restoreConversation` and `restoreWorkState` return the latest snapshot of their type.
- Malformed JSONL and structurally invalid session entries are rejected and reported in `parseErrors` with 1-based line numbers; do not silently discard corruption.
- UI/headless callers decide how to surface parse errors.
- `listSessions` scans workspace sessions into bounded summaries for the `/resume` picker, omits summaries with no non-empty messages, and caches summaries by file size and modification time. `latestSession` uses the same filtered summaries. The process-scoped cache is bounded and invalidates changed or removed files. Resuming in place keeps the original session; forking restores its latest snapshot into a newly created session whose header records `forkedFrom`.

## Tests

Update `tests/core/sessionStore.test.ts` for deferred materialization, empty-session filtering, persistence, restore, malformed-line, cwd hashing, session slimming, and formatting changes.
