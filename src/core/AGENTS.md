# src/core/AGENTS.md

Last updated: 2026-08-15 for the 0.11.0 release.

Core agent behavior, output reduction, safety classification, sessions, validation parsing, tasks, and subagents.

## Boundaries

- Core modules should be UI-agnostic and mostly provider-agnostic.
- Avoid importing React/Ink, CLI mode state, or settings UI code here.
- Prefer pure functions with small typed inputs/outputs. Side-effecting modules (`session`, `tasks`, logs, subagent execution) should keep filesystem/model interactions explicit.

## Important subtrees

- `agent/` — context accounting, model-message compaction, request assembly, tool-result helpers, turn budgets, events, and work state.
- `bashOutput/` — command-aware reduction of bash stdout/stderr, with validation/git/search/diff/json/log reducers and line filters.
- `goal/` — user-request classification, session-goal state, completion/continuation prompts.
- `attachments/` — user-typed image attachment resolution and turn-scoped read blessings for explicit paths.
- `safety/` — bash command trait/risk classification and fail-closed URL SSRF guard, including malformed IP-shaped literals.
- `session/` — lazy durable JSONL session storage, resumable-session summaries/restore helpers, and disk-size slimming for streaming events/large tool outputs.
- `subagent/` — independent tool-loop runner, execution profiles, coordination, and mutation policy used by the `subagent` tool and `/fleet`.
- `tasks/` — workspace-local `.haze/tasks.json` storage.
- `validation/` — parser for test/typecheck/lint/build output summaries.
- `toolOutput/` — shared token/char reduction metrics.
- `process/` — bounded subprocess primitive and shared process-tree signaling (byte-bounded stdout/stderr, timeout, abort, escalation, retained-pipe fallback) used by `bash`, `grep`, and LSP teardown.
- `io/` — bounded UTF-8 stream readers (line iteration, sparse-indexed exact page reads, byte-prefix reads) that cap memory and returned text.
- `limits/` — centralized byte budgets referenced by every collector/reader/storage module.
- `persistence/` — ordered, flushable append writers backing sessions and debug logs.

## Contracts

Maintainability focus:

- Keep loop and safety policy in shared core helpers when both main-agent and subagent flows need it.
- Prefer metadata/reporting for safety classifiers unless a caller explicitly documents enforcement.

- Core should not require configured provider settings except where explicitly passed in.
- Keep serialized shapes backward-tolerant: sessions and tasks may be read after upgrades. Session creation is deferred until resumable content exists, and old zero-message files remain readable but must be omitted from resume/latest listings.
- Tool/result summaries must remain protocol-safe AI SDK `ModelMessage` values.
- Safety classifiers provide metadata and blocking helpers where documented; bash classification is not a confirmation gate.
- Output reduction should reduce context size without hiding actionable failures.

## Tests

Core behavior is heavily tested under `tests/core/**`. If a core type or result shape changes, update both direct core tests and any CLI/LLM tests that consume that shape.
