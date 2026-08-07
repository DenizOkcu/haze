# PLAN.md — implementation plan

Resumable, small increments. Each increment ends with: focused tests,
typecheck, full test, lint, build, `git diff --check`, artifact updates.

Global budgets (DO NOT INCREASE): steps 64, tool calls 120, tool-only steps 24,
output tokens 16384. All recovery counts against these.

## Increment 1 — turn-wide completion foundation (refactor + work-state fix)

**User value:** Today any `bash` call is mislabeled as validation in work state
(an inspection command like `ls` is recorded as "passed validation"), and a
validation recorded before an edit is never marked stale. This makes Haze's own
progress signal unreliable. Also, completion policy is buried inline; a
turn-wide view of "how much budget has this whole turn consumed" does not exist,
so a length finish or a later recovery slice cannot reason about it.

New modules (plain TS, no `ai`/UI imports):

- `src/core/agent/toolCapabilities.ts` — `ToolCapability` union
  (`discovery|read|mutate|validate|process|coordinate`) + `toolCapability(name)`.
- `src/core/agent/completionController.ts` — pure completion logic:
  - `TurnExecutionState` (turn-wide: stepsUsed, toolCallsUsed,
    toolOnlyStepsUsed, finishCause, lengthCreditUsed, rescueUsed,
    mutationCount, lastMutationSeq, lastValidationSeq, validationOutcome,
    recoveryUsed flags, budgetBoundary flag).
  - `decideTerminalStatus(state, input)` reproduces current `terminalTurnStatus`
    decisions exactly (no recovery yet) — the foundation must not change
    outcomes.
  - `budgetReached(state, limits)` pure predicate.
  - Recovery decision stubs (return 'stop' for now) so Increment 2 only flips
    them on.
- `src/core/agent/turnBudget.ts` — `TurnBudget` limits type + helpers
  (`remainingSteps`, `wouldExceed`).

`workState.ts` changes:

- Treat `bash` as validation only when the output carries a `validationSummary`
  (classifier-confirmed). Derive status from the summary, not raw `ok`.
- Add `mutationSeq`/`validationSeq` counters to `WorkState`; a validation whose
  `validationSeq < lastMutationSeq` is `stale`. Add
  `WorkValidationOutcome = passed|failed|stale|absent|not_applicable` and a
  derived `validationOutcome(state)` helper.

`streaming.ts`: thread a `TurnExecutionState` through the attempt, accumulate
global counters (so a retry/recovery slice sees prior usage). Status still via
the controller. No new model calls. Outcomes unchanged.

Tests:
- `tests/core/toolCapabilities.test.ts`
- `tests/core/completionController.test.ts` (normal stop, length, budget,
  recovery-disabled-by-default, abort precedence)
- extend `tests/core/workState.test.ts`: bash-inspection not validation; stale
  after mutation; fresh after post-mutation validation; not_applicable/absent.

Validate: typecheck + tests + lint + build.

## Increment 2 — bounded completion recovery

**User value:** A long answer that hits the output-token ceiling mid-artifact
should be able to continue and still deliver the file/answer, instead of being
reported `failed` when the work was essentially done. Work discovered right at
the tool-only boundary should get one reserved chance to apply the deliverable.

- One turn-wide length-continuation credit. Trigger only when finish is `length`,
  not aborted, credit unused, global budget remains, no satisfactory terminal
  outcome. Cap: 4 steps / 4 tool calls (counted globally). Repeated length →
  clean stop.
- Preserve accumulated response messages; add an ephemeral synthetic control
  (continuation nudge); do not persist it as a user message.
- One completion-rescue slice near the tool-only boundary: reserve the final
  existing tool-only slot (24 → rescue may consume slot 24 only). Rescue exposes
  only mutate+validate capabilities, ≤1 tool step with ≤2 tool calls, +1 final
  tool-free synthesis step. Must not reopen discovery or extend budget.
- Normal successful turns: zero extra model calls (recovery is guarded by
  "no satisfactory terminal outcome").

Tests: table tests (first/repeated length, credit-used, no-budget, abort,
retry-then-recovery, rescue availability/exhaustion, global enforcement across
slices) + scripted model scenarios (length→continue→write; value near boundary
saved; rescue blocked from discovery; normal turn no extra call; abort
authoritative each path).

## Increment 3 — completion evidence

**User value:** Headless/CI consumers cannot today tell why a turn ended or
whether validation actually passed after the latest change. Add bounded evidence
(no raw commands/output).

- Extend `TurnExecutionState` with: validationOutcome, validationKind,
  validationAfterMutation, mutationCount, finishCause, recoveryUsed, budgetBoundary.
- Add to `turn_end` event and terminal `result` line **additively**. Concise
  interactive summary when it improves clarity.
- A known failed validation stays unfinished while budget remains; if budget
  ends, report failed/blocked honestly.

Tests: evidence shapes for passed/failed/stale/absent/not_applicable; safe
output asserts no command/output/credential leakage; consumer parse
compatibility.

## Increment 4 — missing dependency recovery

**User value:** When a needed executable is missing, Haze should try a bounded,
generic safe recovery (find an alternative; inspect project package managers;
permit a project-local install when policy allows; ask before touching the
user's system; or report a precise blocker) instead of just dumping an opaque
error.

- Bounded missing-executable diagnostic. Do not expose full stderr/command text
  in safe events (reuse `safeToolFailureDetails` discipline).
- Generic recovery order, no hardcoded Git/Python/etc.
- System-install permission model: if not already clear and safe, defer and
  document the product decision. Do not guess.

Tests: alternative-found; package-manager install proposed; system-install
deferred/asked; blocker reported; safe output bounded.

## Increment 5 — explicit reasoning policy

**User value:** Let users explicitly request a reasoning depth (`low|medium|high`)
that is mapped by supported provider protocol (not model name), defaulting off,
with clear unsupported behavior. Observable requested/effective without secrets.

- Audit AI SDK/provider protocol support first (reasoning fields per provider
  kind). Capability flag `supportsReasoningEffort` + protocol mapping.
- Settings: optional `reasoning` on `HazeSettings` (and/or per-provider). Unset
  by default. Patching preserves unknown fields (already `.passthrough()`).
- Main + worker consistent unless explicitly configured otherwise.
- Requested/effective observable in safe events (no secrets).
- No env-var config. Mocked provider requests in tests; no network.

Tests: supported setting reaches a mocked provider request; unsupported → clear
result/disabled; settings patch preserves unknown fields; requested/effective
observable.

## Increment 6 — conditional checkpointing (likely DEFERRED)

Do not implement automatically. After 1–3, evaluate with synthetic user
scenarios for a measurable no-artifact problem. If none, explicitly defer and
record the decision in PRODUCTION_READINESS/RETROSPECTIVE.
