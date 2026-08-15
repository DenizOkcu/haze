# src/cli/commands/streaming/AGENTS.md

Last updated: 2026-08-15 for the 0.11.0 release.

Helpers for `src/cli/commands/streaming.ts`.

## Purpose

This subtree keeps the main agent loop readable by isolating display, accounting, and per-turn helper logic.

- `assistantText.ts` sanitizes and filters streamed assistant fragments.
- `abortCause.ts` tracks why a turn's shared AbortController fired (`user` / `turn-deadline` / `model-stream-idle`) so the attempt catch can classify instead of guessing from error strings.
- `toolGroupRenderer.ts` groups native tool calls/results into compact UI messages and emits events/log entries.
- `toolResultState.ts` tracks mutating tool success/failure and edit-recovery state.
- `toolCallRecovery.ts` identifies malformed tool-input errors for the forced smaller-retry path and clamps out-of-range numeric tool arguments to the tool's declared JSON-Schema bounds. The forced retry must use `activeTools: [tool]` + `toolChoice: 'required'`, never the object tool-choice form: OpenAI-compatible servers such as LM Studio and llama.cpp accept only string `tool_choice` values (`none`/`auto`/`required`) and reject the object form with HTTP 400.
- `turnRuntime.ts` contains token/usage extraction, retry delays, context-file memory, abortable delay, and response metrics helpers.
- `turnOutcome.ts` is the authoritative terminal turn-status function (`complete`/`aborted`/`failed`) derived from runtime facts (abort, error, last tool `ok`, finish reason, step/tool budgets, substantive final text, and completion readiness: declared task counts plus post-mutation validation for implement/fix/test intents). `runAgentTurn` calls it once per turn; do not duplicate status inference elsewhere.
- `goalCheckpoint.ts` is the leaf module for bounded continuation checkpoints: the `IncompleteGoalResume` payload on `TurnResult.resume`, the supervisor-level `GoalCheckpoint`, the cumulative progress signature, and the single checkpoint construction site (`buildIncompleteGoalResume`). Safe metadata only (reasons, counts, enums) — never commands, content, or credentials. It must stay import-cycle-free (imports core policy types only) because both `streaming.ts` and `goalSupervisor.ts` depend on it.
- `goalSupervisor.ts` owns the logical goal across physical turns (`runAgentGoal`). It wraps `runAgentTurn`: a `recoverable-incomplete` physical turn — including step/tool budget boundaries that finish as `tool-calls` — automatically starts the next physical turn against the preserved conversation (no duplicate user message, attachments only on the first attempt, one shared turn scope/mutation lease, `goalContext` seeding carried evidence). It stops only for structured completion, hard blockers, user cancellation, the whole-goal deadline, or two consecutive no-progress cycles (cumulative signature: mutations, validation outcome, task counts; the first no-progress cycle is the allowed corrective). Per-turn limits are safety boundaries, not goal completion. It emits exactly one `goal_start`, `goal_continue` between turns, and one terminal `goal_end`; background-process teardown and headless `--timeout` apply at goal level, not per turn.

### Autonomous goal continuation and honest pauses

- When a model voluntarily stops with a substantive final while completion readiness says work remains (pending/in-progress declared tasks, or missing/stale/failed validation after edits), `decideGoalContinuation` continues the same logical turn with a synthetic control (`goalContinuationPrompt`): same conversation, mutation lease, `WorkState`, and `TurnBudget`. It keeps the full tool set, unlike the discovery-free rescue slice.
- Continuation slices clamp to the remaining global budget and never reset it. When no same-turn recovery can run — global step/tool budget exhausted (any recoverable finish shape, including `tool-calls` and `length`), the turn deadline, or the no-progress guard — the attempt ends `failed` with an `incomplete-goal` checkpoint instead of a silent failure. The supervisor converts checkpoints into fresh physical turns; the interactive UI auto-continues and exposes the `R` key only for genuinely paused goals (two no-progress cycles, goal deadline, or a stalled model stream — each carrying safe resume metadata via `GoalRunResult.resume`). Headless results include the goal envelope (cycles, stop reason, cumulative mutations/validation/task counts) and exit non-zero unless the goal structurally completed.
- A claimed blocker in prose stops nothing by itself: only structured evidence (failed tool, permission/dependency/environment error) or the readiness gates decide; prose can never turn pending work into `complete`.

## Contracts

Maintainability focus:

- Share loop-policy helpers with `core/agent/turnPolicy.ts` instead of duplicating tool-budget or repeated-tool logic.
- Keep provider/model fallback behavior aligned with headless preflight checks.

- Keep helpers deterministic where possible. UI callbacks and logs should be injected, not imported from chat state.
- Assistant text filtering must avoid hiding substantive final answers while suppressing duplicated/empty/lead-in fragments around tool calls.
- Tool result state drives model constraints in `prepareStep`; changes here can alter autonomy behavior and must be tested. Advance it from ordered `onStepEnd` content, not the later public stream, so fast providers cannot race recovery state. Read-only recovery applies only when a structured mutation failure explicitly requests `readFile`, and equivalent lexical workspace paths must satisfy it.
- Repeated identical calls may suppress that tool for the immediately following step only. A duplicate earlier in the turn must not permanently remove an edit/write tool.
- Token estimates are approximate display/control inputs, not billing truth. Preserve provider usage fields when available.
- Context files discovered from tool outputs should be remembered for the active turn only; durable context loading belongs in `config/contextFiles.ts`.
- Turn options separate durable user value from ephemeral synthetic control and subagent overrides. Reapply control on retry, strip it before conversation/session writes, and share one workspace mutation scope across main and worker tools. User-attached images (F03) ride along as `attachments` on the first attempt only; `userTurnMessage` keeps text-only turns as a plain string payload.

### Abort causes and idle-stall recovery

- The idle timer, the absolute turn deadline, and user cancel share one AbortController; the cause is recorded in the per-turn `TurnAbortCause` holder (`abortCause.ts`) by whichever internal site aborts first. A user abort never sets it.
- A model-stream idle stall is a retryable transport failure, but only while the stalled step emitted nothing visible (`stallEmission === 'none'`): partial text or an in-flight tool is never auto-retried. Idle stalls share one bounded retry pool (`MAX_MODEL_RETRIES`) with transient model errors.
- An idle-stall retry salvages the conversation from the last fully completed step (via `onStepEnd`'s accumulated response messages) so completed — possibly mutating — tool work is never re-run, and requires a fresh AbortController (`retry.freshController`) because the stall aborted the old one.
- When bounded retries are exhausted or the stall is not retryable, the turn pauses (status `failed`, not `aborted`) with the active goal preserved and `TurnResult.resume` carrying the original request plus where the retry pool stopped. The interactive UI offers a one-key R resume; headless consumers ignore it and the system message suggests a follow-up.
- Stall diagnostics (provider/model, last stream-event time/type, stall emission, work phase, retry eligibility) go to the `timeout` agent event, the `--debug` LLM log, and the debug panel as safe metadata only — never prompt content or credentials.

## Tests

Use/update:

- `tests/cli/streamingFragments.test.ts`
- `tests/cli/streamingHelpers.test.ts`
- `tests/cli/toolGroupCaption.test.ts`
- `tests/cli/toolResultState.test.ts`
- `tests/cli/turnRuntime.test.ts`
- `tests/cli/turnOutcome.test.ts`
- `tests/cli/commands/streaming.test.ts` (turn stack, recovery, end-to-end goal continuation)
- `tests/cli/commands/streaming/goalSupervisor.test.ts` (supervisor decisions)
