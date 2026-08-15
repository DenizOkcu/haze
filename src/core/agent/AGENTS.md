# src/core/agent/AGENTS.md

Last updated: 2026-08-15 for the 0.11.0 release.

Agent request assembly, compaction, budgets, events, work state, and tool-result helpers.

## Module contracts

Maintainability focus:

- `turnPolicy.ts` is the shared home for tool-loop/repeated-tool decision helpers used outside the UI. Do not reimplement these in subagents or CLI helpers. `latestRepeatedToolNames` intentionally scopes suppression to a duplicate introduced by the latest step; do not turn one earlier duplicate into a turn-long tool ban.

- `completionController.ts` is the pure, unit-testable home for the authoritative turn-completion decision (`decideTerminalStatus`), completion readiness (`assessCompletionReadiness`: ready / pending_tasks / validation_failed / validation_stale / validation_absent_after_mutation / tool_failure / unresolved_tool_input / aborted), terminal classification (`classifyTerminalOutcome`: goal-complete / recoverable-incomplete / hard-blocked / user-aborted), turn-wide budget exhaustion (`isBudgetExhausted`), the turn-wide `TurnExecutionState`, finish-cause normalization, recovery decision entry points, and the "satisfactory terminal outcome" guard. The CLI `turnOutcome.ts` adapter keeps the single call site and delegates here; do not duplicate status inference elsewhere. Recovery decisions default to disabled and are enabled incrementally with explicit guards (abort wins, credit once-only, global budget enforced).
- Completion readiness consumes structured evidence only — declared task counts, mutation/validation sequence, last tool status. A substantive assistant text is never sufficient by itself. Terminal classification treats `stop`, `tool-calls`, `length`, and `unknown` finishes as potentially recoverable (a step/tool budget boundary ends a physical turn, not the logical goal); `error`/`content-filter` and concrete tool/input failures stay hard. The goal-level invariant — a failed attempt with recoverable readiness and no same-turn recovery must yield an `incomplete-goal` checkpoint, never a silent failure or `complete` — is enforced in the streaming layer from the classification, not inside `decideGoalContinuation`.
- Goal continuation (`decideGoalContinuation` / `recordGoalContinuation`) is the same-turn recovery path for rejected premature finals. It is repeatable across its own slices while measurable progress continues (work/task signature comparison), never resets turn-wide budgets, and allows exactly one no-progress corrective nudge. Cross-turn continuation is owned by the goal supervisor (see `src/cli/commands/streaming/AGENTS.md`); length-continuation and rescue remain single-use credits for their own finish shapes.
- `budgets.ts` centralizes all agent-loop budget math: main agent/subagent step, tool-call, output-token, and idle-timeout limits (constants), the turn-wide `TurnBudget` envelope with pure remaining/clamp helpers (recovery slices count against these and must never increase them), and the tool execution-boundary budget (`withToolExecutionBudget` / `isToolBudgetBlocked` / `ToolExecutionBudgetState`, RH-003). Changing values changes product behavior; update tests and docs if user-visible. Model-facing text/byte caps live in `core/limits.ts`, and token estimation in `contextBudget.ts`.
- `toolCapabilities.ts` provides static capability metadata (`discovery|read|mutate|validate|process|coordinate`) for built-in tools. Capabilities are policy/observability metadata, never an execution gate; a `bash` call is only validation when its command is runtime-classifier confirmed (tracked as a validation event in work state).

- `contextBudget.ts` contains approximate token estimation and breakdown helpers. Keep deterministic and cheap.
- `goalPolicy.ts` is the shared home for goal/completion policy: request-intent classification (`classifyRequestIntent` / `isPlanOnlyRequest` — deterministic heuristics, hints not hard authorization; plan-only requests must not lead to source mutations unless the user asks), session-goal state (`createSessionGoal` / `observeGoalToolEvent` / `formatGoalStatus`, building on `workState`), and the model-facing completion/continuation control prompts (`repeatedToolCallPrompt`, `toolLoopBudgetPrompt`, `lengthContinuationPrompt`, `completionRescuePrompt`, `malformedToolCallPrompt`, `goalContinuationPrompt`). Keep prompts small and reusable — one shared helper over near-identical control text in multiple loops; they are one-request nudges, never durable conversation history. Goal status text is shown in UI; keep it short and stable.
- `requestAssembly.ts` handles synthetic controls and active-conversation tool-history compaction. Synthetic `<haze_control>` messages are one-request nudges and must not be persisted as durable user conversation.
- `compaction.ts` compacts model messages with token budgets and embeds structured work state. It must preserve recent messages and enough task/tool context to continue safely.
- `toolResults.ts` contains guards and field helpers used by CLI, tool context, and request assembly. Keep guards tolerant of unknown provider/tool output shapes. A failed mutation requires read recovery only when its result explicitly carries `recoveryTool: 'readFile'`; argument-only failures must remain directly retryable with corrected input.
- `toolOutputStore.ts` stores process-scoped raw/reduced output handles with per-entry (`TOOL_OUTPUT_ENTRY_BYTES`) and aggregate (`TOOL_OUTPUT_TOTAL_BYTES`) byte budgets, shared UTF-8-safe truncation, and LRU eviction. Handles are not durable session references, should be cleared for new sessions, and report omitted bytes truthfully when collection overflow is dropped.
- `events.ts` defines structured agent events for sessions/headless/UI. Additive changes are preferred.
- `workState.ts` defines structured work state included in compaction/session snapshots. It records mutation/validation sequence numbers so a validation that predates the latest mutation is `stale` (`deriveValidationOutcome`: passed/failed/stale/absent/not_applicable). Only a classifier-confirmed bash command (output carries a `validationSummary`) is recorded as a validation step; an arbitrary shell call is process work. A successful `writeTasks` result records bounded current-turn task counts in `taskProgress` (counts only, via `taskProgressFromOutput`; malformed output is ignored). Task evidence is per-turn unless hydrated from a goal checkpoint via `seedCarriedGoalEvidence` (seq baselines + `carriedValidation` keep cross-physical-turn semantics truthful: carried stale/absent keeps demanding validation, carried passed/failed stands until the turn mutates or validates); a stale workspace `tasks.json` from an unrelated turn must never block completion.

## Compaction and protocol safety

- Never leave malformed AI SDK tool-call/tool-result pairs in compacted messages.
- Do not compact recent failures or recovery-relevant outputs away.
- For old successful outputs, keep metadata such as path, command, status, handles, counts, reducer names, validation summary, and token savings.
- Compact large mutating tool inputs (`writeFile`, `editFile`, `replaceLines`, long bash commands) only after they are old enough; preserve path and recovery hints.

## Tests

Use/update:

- `tests/core/agent.test.ts`
- `tests/core/requestAssembly.test.ts`
- `tests/core/contextBudget.test.ts`
- `tests/core/events.test.ts`
- `tests/core/workState.test.ts`
- `tests/core/agent/toolOutputStore.test.ts`
- streaming tests when behavior affects `runAgentTurn`.
