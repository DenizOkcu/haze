# RESEARCH.md — codebase findings

Last updated: 2026-08-07. Read before every increment.

## Source plan status

`benchmarks/harbor/reports/2026-08-07-haze-sustainable-improvement-plan.md` is
**absent** (see REQUEST.md). The objective's own increment roadmap is the
authoritative spec. Benchmark summary
(`benchmarks/harbor/results/...terminal-bench.md`) read for general context only
and deliberately not used to derive requirements.

## Turn loop (`src/cli/commands/streaming.ts`)

`runAgentTurn` is the public entry. It owns one `AbortController`, emits
`turn_start`/`turn_end` events, and loops `runAgentAttempt` while a result asks
for a `retry`. Retries are bounded: context-overflow recovery (compaction, once)
and retryable model errors (`maxRetries = 2`).

`runAgentAttempt` builds one `ToolLoopAgent` from the AI SDK per attempt:

- `stopWhen: isStepCount(MAIN_STEP_LIMIT)` (64) — the SDK stops the stream at
  64 steps. Counters `completedSteps/completedToolCalls/completedToolOnlySteps`
  are **per-attempt**, tracked in `onStepEnd`.
- `prepareStep` enforces tool budgets locally: disables repeated tools, forces
  `toolChoice: 'none'` when `toolCalls.length >= MAIN_TOOL_CALL_LIMIT` (120) or
  `toolOnlyStepCount(steps) >= MAIN_TOOL_ONLY_STEP_LIMIT` (24), and runs the
  malformed-tool-call / edit-recovery logic.
- Final status comes from `terminalTurnStatus(...)` (see below).

Budgets (`src/core/agent/budgets.ts`): `MAIN_STEP_LIMIT=64`,
`MAIN_TOOL_CALL_LIMIT=120`, `MAIN_TOOL_ONLY_STEP_LIMIT=24`,
`DEFAULT_MAX_OUTPUT_TOKENS=16384`, `IDLE_TIMEOUT_MS=5min`,
`ACTIVE_CONTEXT_TOKEN_BUDGET=40000`.

## Completion policy today

`src/cli/commands/streaming/turnOutcome.ts` — `terminalTurnStatus(input)`:

```
aborted -> 'aborted'
error or lastToolOk===false or unresolvedToolInputError -> 'failed'
budgetReached || finishReason in {length,error} -> 'failed'
sawToolCall && no text -> 'failed'
text present -> 'complete' else 'failed'
```

`budgetReached` is computed in the attempt:
`finishReason==='length' || steps>=64 || toolCalls>=120 || toolOnlySteps>=24`.

Key gap driving Increments 1–3: a `length` finish today is unconditional
`failed`, even if the model had already produced the requested artifact but ran
out of output tokens mid-sentence. There is no length-continuation.

## Work state (`src/core/agent/workState.ts`, surfaced via `sessionGoal.ts`)

`createSessionGoal(request)` -> `createWorkState(...)`. `observeWorkToolEvent`
mutates state on each tool result. `WorkState` carries files, touchedFiles,
validations, validationCommands, blockers, pending, phase, status.

**Confirmed bug (Increment 1 target):** the `bash` branch treats *any* bash
call as validation using `ok ? 'passed' : 'failed'`, ignoring whether the
command is actually a validation command. So `echo hi` or `mkdir build` is
recorded as a passed/failed validation. The bash tool already computes a
`validationSummary` only when `isValidationClassification(classification)`
(`src/core/safety/bashClassifier.ts`), and embeds it in its output. The fix:
treat bash as validation only when the output carries a `validationSummary`
(classifier-confirmed), and derive status from that summary rather than raw
`ok`.

There is **no mutation/validation sequencing** today — a validation is never
marked stale after a later edit. Increment 1/3 add sequence numbers so a
validation that predates the latest mutation becomes `stale`.

## Validation parser (`src/core/validation/outputParser.ts`)

`parseValidationOutput` -> `ValidationSummary` (`kind`, `status`
passed/failed/timed_out/unknown, failedFiles, failedTests, diagnostics,
summaryText, suggestedNextStep). Status treats parsed failure evidence as
authoritative over exit code (pipes can mask non-zero exits). Kind inference
honors bash traits `runs_tests`/`runs_build`.

## Bash classifier (`src/core/safety/bashClassifier.ts`)

`classifyBashCommand` -> riskLevel + traits. `isValidationClassification`
returns true for `runs_tests || runs_build`. Classification is metadata, not a
gate. Validation kind is inferred from command text + traits.

## Provider/request layer (Increment 5)

- `src/llm/client.ts`: `modelWithConfig`, `providerRequestSettings(config)`.
  Capabilities are derived from provider **protocol/kind** (`chatgpt-codex` vs
  OpenAI-compatible vs OpenRouter), never model name.
  `ProviderCapabilities` (`src/core/subagent/contracts.ts`): reportsCacheUsage,
  supportsPromptCacheKey, supportsExtendedCacheRetention, supportsStickySessionId,
  supportsServerCompaction, supportsTextVerbosity.
- `providerRequestSettings` already branches on `providerKind` and capabilities
  (sets OpenAI `textVerbosity: 'low'` when `supportsTextVerbosity`). This is the
  natural seam for a reasoning setting mapped by provider protocol.
- Settings (`src/config/settings.ts`): Zod schemas use `.passthrough()` so
  unknown fields are preserved on patch. `HazeProviderSettings.capabilities` is
  the per-provider capability override (images today). Provider `kind` is the
  protocol selector.

## Headless output (Increment 3)

`src/cli/commands/runCommand.ts`: `--output text|json|stream-json`.

- stream-json emits one NDJSON line per `AgentEvent` via `toHeadlessStreamEvent`,
  then a terminal `{type:'result', status, result, usage}` line.
- json emits only the terminal `result` line.
- `tool_start`/`tool_end` intentionally omit raw tool input and most output.
  `tool_end` exposes only bounded Haze failure `errorCode`/`error`.

The additive evidence seam is the `turn_end` event and the terminal `result`
line. Both are safe to extend; raw commands/output stay out.

## Synthetic controls (`src/core/agent/requestAssembly.ts`)

`withSyntheticControl(messages, control)` appends a `<haze_control>` user message.
`stripSyntheticControls` removes them. Controls are one-request nudges, stripped
before conversation/session writes. This is the mechanism for Increment 2's
ephemeral recovery control (must NOT persist as a user message).

## Events (`src/core/agent/events.ts`)

`AgentEvent` union, `agentEvent()` stamps `at`. Additive changes preferred. The
`turn_end` event carries `status` only today; evidence can be added there.

## Existing tests (patterns to follow)

- `tests/cli/turnOutcome.test.ts` — pure table test of `terminalTurnStatus`.
- `tests/core/workState.test.ts` — exercises `observeWorkToolEvent`.
- `tests/core/validationParser.test.ts`, `tests/core/bashClassifier.test.ts`.
- `tests/cli/streamingHelpers.test.ts`, `toolResultState.test.ts`.
- Tests are deterministic Vitest, temp dirs for fs, mocked providers for network.

## Invariants to preserve (review checklist anchors)

- Global budgets never reset across retries/recovery slices.
- Recovery cannot loop (each credit used at most once; repeated length terminates).
- Abort always wins (checked before/after every slice and during delays).
- Routine successful turns make no extra model calls (recovery is opt-in only
  when a terminal outcome is unsatisfactory AND budget remains AND not aborted).
- Evidence never overclaims correctness.
- Safe output never leaks commands/tool input/output/credentials.
- Provider behavior is capability/protocol based, never model-name based.
- Settings patching preserves unknown fields (`.passthrough()`).

## Non-goals confirmed

- No benchmark task logic, fixtures, or verifier assumptions in product code.
- No model-name branching.
- No budget increases.
- Increment 6 (checkpointing) is conditional and likely deferred unless a
  measurable product problem remains after 1–3.
