# IMPLEMENTATION.md

## Increment 1 — turn-wide completion foundation ✅ COMPLETE

### Modules added (plain TS, no `ai`/UI imports)

- `src/core/agent/toolCapabilities.ts` — static capability metadata
  (`discovery|read|mutate|validate|process|coordinate`) + helpers
  (`toolCapability`, `isMutatingCapability`, `isValidationCapable`,
  `isReadOrDiscoveryCapability`). Metadata only, never an execution gate.
- `src/core/agent/turnBudget.ts` — turn-wide `TurnBudget` envelope (the global
  step/tool/tool-only limits) + pure helpers (`remainingSteps`,
  `remainingToolCalls`, `wouldExceedToolCalls`, `hasUsableBudget`, `clampSlice`).
- `src/core/agent/completionController.ts` — pure completion policy:
  `TurnExecutionState` (turn-wide: steps/toolCalls/toolOnlySteps used,
  finishCause, length/rescue credit flags, mutation/validation evidence,
  budgetBoundary, aborted), `normalizeFinishReason`, `isBudgetExhausted`,
  `decideTerminalStatus` (reproduces the old `terminalTurnStatus` exactly),
  `hasSatisfactoryTerminalOutcome`, and recovery decision entry points
  (`decideLengthRecovery`, `decideRescue`) that **return 'stop' (disabled)** in
  this increment.

### Behavior changes

1. **Work-state validation fix (`workState.ts`)** — an arbitrary `bash` call is
   no longer recorded as validation. Only a classifier-confirmed bash command
   (one whose output carries a `validationSummary`) is recorded as a validation
   step, with status derived from the summary (not raw `ok`). Fixes the real bug
   where `ls`/`mkdir`/`echo` were mislabeled as passed/failed validation.
2. **Mutation/validation sequencing** — `WorkState` gained `mutationCount`,
   `mutationSeq`, `validationSeq`. `deriveValidationOutcome(state)` returns
   `passed|failed|stale|absent|not_applicable` (stale when a mutation happened
   after the validation). `intentExpectsValidation(intent)` distinguishes
   `absent` (implement/fix/test never validated) from `not_applicable`
   (answer/review/plan).
3. **Turn-wide execution state** — `streaming.ts` now threads a single
   `TurnExecutionState` through every attempt; `onStepEnd` accumulates turn-wide
   counters (not per-attempt). The final `budgetReached` is computed via
   `isBudgetExhausted(turnState, turnBudget)` so the global budget cannot reset
   across provider retries. `terminalTurnStatus` is now a thin CLI adapter that
   delegates to `decideTerminalStatus`; status inference is no longer duplicated.
4. **Abort** sets `turnState.aborted = true` in the abort path.

### Reproduced behavior

For normal successful turns (no retry, no recovery), outcomes are byte-identical
to before: no new model calls, same `complete`/`failed`/`aborted`. The only
behavior change for retried turns is the mandated tightening: a retried turn no
longer resets its global step/tool budget (review requirement: "global budgets
cannot reset across retries or recovery slices"). Recovery itself is disabled.

### Tests added/updated

- `tests/core/toolCapabilities.test.ts` (new)
- `tests/core/turnBudget.test.ts` (new)
- `tests/core/completionController.test.ts` (new, table-driven: normal stop,
  first/repeated length, no budget, abort precedence, failed/passed/stale/
  absent/not-applicable inputs, recovery-disabled)
- `tests/core/workState.test.ts` (extended: bash-inspection-not-validation,
  mutation sequencing, all five validation outcomes, summary extraction)
- `tests/cli/commands/streaming.test.ts`, `tests/core/goal.test.ts` — mock bash
  outputs updated to the realistic shape (with `validationSummary`) that real
  classifier-confirmed validation commands carry.

### Validation (Increment 1)

- `npm run typecheck` ✅
- `npm test` (full) ✅ 133 files / 1281 tests
- `npm run lint` ✅
- `npm run build` ✅
- `git diff --check` ✅

### Review findings

None required. Confirmed: budgets turn-wide & non-resetting; recovery disabled
(cannot loop); abort always wins; routine turns make no extra calls; evidence
honest (stale after mutation); no new raw output in events; no benchmark logic;
provider/model agnostic.

## Increment 2 — bounded completion recovery ✅ COMPLETE

### Behavior added

1. **Length-continuation credit (turn-wide, single-use).** When a response is
   truncated by an output-length finish (`finishReason: 'length'`), the turn is
   not aborted, the credit is unused, step/tool budget remains, and no fresh
   passing validation already landed, one continuation slice runs: up to 4 model
   steps / 4 tool calls (clamped to remaining global budget). It preserves the
   accumulated conversation and appends an ephemeral synthetic control
   (`lengthContinuationPrompt`) — never persisted as a user message. A repeated
   length finish terminates cleanly (credit is single-use).
2. **Completion-rescue slice (single-use).** When normal exploration exhausts
   the reserved tool-only boundary (`RESCUE_BOUNDARY = MAIN_TOOL_ONLY_STEP_LIMIT
   - 1`) on a mutating request without a substantive answer, one rescue slice
   runs: ≤2 model steps / ≤2 tool calls, exposing **only mutation +
   validation-capable tools** (editFile/replaceLines/writeFile/bash). Discovery,
   read, and coordinate tools are dropped so the rescue cannot reopen
   exploration. The main flow reserves the final tool-only slot by forcing text
   at the boundary.
3. **Normal successful turns make no extra model calls** — both decisions
   decline when there is a substantive terminal outcome or the finish is not a
   length/boundary stop.

### Correctness invariants (review-verified)

- Global budgets are turn-wide and never reset across retries or recovery
  slices (`onStepEnd` accumulates `turnState`; `clampSlice` bounds each slice;
  `prepareStep` enforces turn-wide tool-call + slice caps).
- Recovery cannot loop: credits are single-use; a recovery slice never proposes
  another (`!turnOptions.recoverySlice` guard + controller declines once used).
- Abort always wins (`!abortController.signal.aborted` before each slice;
  controllers decline when aborted; abort path sets `turnState.aborted`).
- A bug found & fixed during this increment: `isBudgetExhausted` counted a
  `length` finish as exhausted, which would have made length-recovery unreachable.
  Recovery now uses the new `hasRemainingRecoveryBudget` (step/tool-call only);
  the terminal `budgetReached` still counts `length` as exhausted → `failed`.

### Tests added

- `tests/core/completionController.test.ts`: length continuation (continue once,
  decline when not-length/aborted/credit-used/budget-gone/already-passed);
  rescue (continue at boundary for mutating requests, decline off-boundary /
  non-mutating / used / aborted / satisfactory).
- `tests/cli/commands/streaming.test.ts`: 5 scripted scenarios via extended mock
  (`callStreams`, `callStepEnds`, `availableTools`) — normal turn = 1 call;
  length→continue→write→complete; repeated length = clean stop (2 calls); rescue
  near boundary runs a restricted slice saving the value; non-mutating request
  gets no rescue.

### Validation (Increment 2)

typecheck ✅ · full suite 1294/1294 ✅ · lint ✅ · build ✅ · git diff --check ✅

## Increment 3 — completion evidence ✅ COMPLETE

### Behavior added

- `TurnCompletionEvidence` (in `completionController.ts`): `validationOutcome`
  (passed|failed|stale|absent|not_applicable), `validationKind`,
  `validationAfterMutation`, `mutationCount`, `finishCause`, `recoveryUsed`
  ({length, rescue}), `budgetBoundary`. Projected from the turn-wide state via
  `toCompletionEvidence(state)`.
- Surfaced **additively** and safely:
  - `turn_end` AgentEvent gains optional `evidence`.
  - Headless `turn_end` stream event and the terminal `result` line carry
    `evidence` (stream-json + json).
- Evidence contains only enums, booleans, and counts — never raw commands, tool
  inputs/outputs, or credentials (asserted in tests).
- A known failed validation keeps the turn unfinished (`failed`) while the
  evidence reports it honestly; if the budget ends, `budgetBoundary` is true.

### Tests added

- `tests/core/completionController.test.ts`: `toCompletionEvidence` projection
  (passed/failed/absent/not_applicable), kind omission, and a leakage guard
  (no command/stdout/stderr/error/key/token/path fields).
- `tests/cli/commands/runCommand.test.ts`: JSON envelope includes bounded
  `evidence`; leakage guard.
- `tests/cli/commands/streaming.test.ts`: `turn_end` carries validation evidence
  and length-recovery evidence. Existing status assertions migrated to
  `toMatchObject` (additive shape).

### Validation (Increment 3)

typecheck ✅ · full suite 1301/1301 ✅ · lint ✅ · build ✅ · git diff --check ✅

## Increment 4 — missing dependency recovery ✅ COMPLETE

### Behavior added

- `src/core/safety/missingExecutable.ts` — generic, dependency-agnostic
  `detectMissingExecutable({command, code, stderr})`. Detects exit 127 / "command
  not found" (bash, zsh, generic forms) and derives the executable name. Returns
  only `{executable, suggestedNextStep}` — never raw stderr/command. The
  suggestedNextStep follows the generic recovery order: alternative → project
  manifest/local install → consent-gated system install → precise blocker.
- Wired into the `bash` tool: on failure it adds a bounded `reasonCode:
  'missing_executable'`, `missingExecutable: <name>`, and a generic
  `missingExecutableStep`.
- `safeToolFailureDetails` (toolResults) now surfaces a bounded
  `{errorCode: 'missing_executable', missingExecutable: <name>}` in safe
  `tool_end` events — no stderr, no command text.
- `'missing_executable'` added to `ToolFailureReasonCode`.

### Deferred (documented product decision)

A system-install permission model is NOT implemented. The diagnostic asks for
consent and reports the blocker; it never silently modifies a user-managed
toolchain (per the hard constraint and the objective's "do not guess" rule).
No behavior is hard-coded for Git, Python, Docker images, or any specific
dependency.

### Tests added

- `tests/core/missingExecutable.test.ts`: bash/zsh/generic detection, first-token
  fallback with env/VAR-wrapper stripping, dependency-agnostic guidance,
  non-missing failures return undefined, and a leakage guard (no
  secret/flag/stderr in bounded fields).
- `tests/core/toolResults.test.ts`: `safeToolFailureDetails` surfaces the bounded
  missing-executable diagnostic without raw stderr/command.

### Validation (Increment 4)

typecheck ✅ · full suite 1309/1309 ✅ · lint ✅ · build ✅ · git diff --check ✅

## Increment 5 — explicit reasoning policy ✅ COMPLETE

### AI SDK / provider-protocol audit (done before coding)

`@ai-sdk/openai@4.0.30` chat provider reads
`providerOptions.openai.reasoningEffort` (`none|minimal|low|medium|high|xhigh|max`)
and maps it to the request `reasoning_effort`, validating it against reasoning
models on the provider side. The responses provider mirrors this. This is the
protocol seam: Haze sets the provider option; the provider validates the model.

### Behavior added

- `src/core/agent/reasoningPolicy.ts` — pure, capability-based policy:
  `ReasoningLevel = low|medium|high`, `resolveReasoningPolicy({requested,
  capabilities})` → `{requested, effective: level|'disabled', reason}`, and
  `reasoningProviderOptions`. No model-name branching.
- `ProviderCapabilities.supportsReasoningEffort` (true only for the direct
  OpenAI protocol; false for OpenRouter, chatgpt-codex, generic
  openai-compatible). Added to `fallbackProviderCapabilities`.
- `providerRequestSettings(config)` now sets `openai.reasoningEffort` only when
  the policy is effective; disabled protocols send nothing (never an undefined
  shape). Existing cache/verbosity behavior preserved.
- `HazeSettings.reasoning?: ReasoningLevel` (Zod `enum`, `.passthrough()` keeps
  unknown fields). Unset by default; invalid values fail loudly. No env vars.
- Main and worker runtimes share one path (`runtimeForSelection` →
  `config.reasoningPolicy` → `providerRequestSettings`), so they behave
  consistently.
- Observable: a safe `reasoning_policy` AgentEvent (requested/effective/reason —
  level strings only, no secrets) emitted after model resolution, surfaced in
  stream-json.

### Tests added

- `tests/core/reasoningPolicy.test.ts`: policy resolution (supported→applied,
  unsupported→disabled, no-request→disabled, no model-name branching) and
  `providerRequestSettings` mapping (includes/omits reasoningEffort; cache/
  verbosity preserved) — all pure, no network.
- `tests/config/settings.test.ts`: `reasoning` parses; invalid fails loudly;
  unknown fields preserved across patch.

### Validation (Increment 5)

typecheck ✅ · full suite 1319/1319 ✅ · lint ✅ · build ✅ · git diff --check ✅
