# src/core/AGENTS.md

Core agent behavior, output reduction, safety classification, sessions, validation parsing, tasks, and subagents.

## Boundaries

- Core modules should be UI-agnostic and mostly provider-agnostic.
- Avoid importing React/Ink, CLI mode state, or settings UI code here.
- Prefer pure functions with small typed inputs/outputs. Side-effecting modules (`session`, `tasks`, logs, subagent execution) should keep filesystem/model interactions explicit.

## Important subtrees

- `agent/` — context accounting, model-message compaction, request assembly, tool-result helpers, turn budgets, events, and work state.
- `bashOutput/` — command-aware reduction of bash stdout/stderr, with validation/git/search/diff/json/log reducers and line filters.
- `goal/` — user-request classification, session-goal state, completion/continuation prompts.
- `safety/` — bash command trait/risk classification and URL SSRF guard.
- `session/` — durable JSONL session store and restore helpers.
- `subagent/` — independent tool-loop runner used by the `subagent` tool.
- `tasks/` — workspace-local `.haze/tasks.json` storage.
- `validation/` — parser for test/typecheck/lint/build output summaries.
- `toolOutput/` — shared token/char reduction metrics.

## Contracts

- Core should not require configured provider settings except where explicitly passed in.
- Keep serialized shapes backward-tolerant: sessions and tasks may be read after upgrades.
- Tool/result summaries must remain protocol-safe AI SDK `ModelMessage` values.
- Safety classifiers provide metadata and blocking helpers where documented; bash classification is not a confirmation gate.
- Output reduction should reduce context size without hiding actionable failures.

## Tests

Core behavior is heavily tested under `tests/core/**`. If a core type or result shape changes, update both direct core tests and any CLI/LLM tests that consume that shape.
