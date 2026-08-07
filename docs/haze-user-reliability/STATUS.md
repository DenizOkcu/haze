# STATUS.md

Current phase: **Increments 1–5 COMPLETE & validated. Increment 6 DEFERRED by evaluation. Workflow complete.**
Next action: none required. Revisit Inc 6 only if dogfooding reveals a measurable no-artifact case not covered by compaction + recovery.

## Phases

- [x] Increment 1 — turn-wide completion foundation (refactor + work-state fix)
- [x] Increment 2 — bounded completion recovery (length continuation + rescue)
- [x] Increment 3 — completion evidence (additive JSON/stream-JSON)
- [x] Increment 4 — missing dependency recovery
- [x] Increment 5 — explicit reasoning policy
- [~] Increment 6 — conditional checkpointing → DEFERRED (justified in PRODUCTION_READINESS)

## Decisions log

- 2026-08-07: Source plan file absent; objective roadmap is authoritative spec.
- 2026-08-07: Baseline green. Working tree clean except untracked `benchmarks/`.
- 2026-08-07: Recovery disabled in Increment 1 (controller returns 'stop'); normal-turn outcomes byte-identical.
- 2026-08-07: Final budget computed turn-wide (`isBudgetExhausted(turnState)`); retried turns no longer reset global budget (mandated tightening).
- 2026-08-07: `.gitignore` shows unrelated benchmark ignore entries (not authored here); preserved untouched per constraints.

## Changed files

Increment 1 source:
- `src/core/agent/toolCapabilities.ts` (new)
- `src/core/agent/turnBudget.ts` (new)
- `src/core/agent/completionController.ts` (new)
- `src/core/agent/workState.ts` (bash-as-validation fix + sequencing)
- `src/core/agent/AGENTS.md` (docs)
- `src/cli/commands/streaming.ts` (turn-wide state threading)
- `src/cli/commands/streaming/turnOutcome.ts` (delegates to controller)

Increment 1 tests:
- `tests/core/toolCapabilities.test.ts`, `tests/core/turnBudget.test.ts`, `tests/core/completionController.test.ts` (new)
- `tests/core/workState.test.ts` (extended)
- `tests/cli/commands/streaming.test.ts`, `tests/core/goal.test.ts` (mock outputs updated to realistic shape)

Increment 2 source:
- `src/core/agent/completionController.ts` (length/rescue decisions enabled, `hasRemainingRecoveryBudget`, slice constants, `RESCUE_BOUNDARY`)
- `src/core/goal/completionPolicy.ts` (`lengthContinuationPrompt`, `completionRescuePrompt`)
- `src/cli/commands/streaming.ts` (turn-wide goal, recovery slice orchestration, slot-24 reservation, slice tool restriction, prepareStep turn-wide caps)

Increment 2 tests:
- `tests/core/completionController.test.ts` extended (length continuation/rescue enabled, single-use, abort, budget, mutating vs non-mutating, boundary)
- `tests/cli/commands/streaming.test.ts` extended (mock `callStreams`/`callStepEnds`/`availableTools`; 5 recovery scenarios: normal-no-extra-call, length→continue→write, repeated-length-clean-stop, rescue-restricted-tools-saves-value, non-mutating-no-rescue)

Increment 3 source:
- `src/core/agent/completionController.ts` (`TurnCompletionEvidence`, `toCompletionEvidence`)
- `src/core/agent/events.ts` (`turn_end` evidence)
- `src/cli/commands/streaming.ts` (evidence in turn_end + return)
- `src/cli/commands/runCommand.ts` (evidence in headless turn_end + result line)

Increment 4 source:
- `src/core/safety/missingExecutable.ts` (new, generic diagnostic)
- `src/core/agent/toolResults.ts` (bounded missing-executable errorCode)
- `src/llm/tools/bashTool.ts` (detect + bounded fields)
- `src/llm/toolResultTypes.ts` (`missing_executable` reasonCode)
- `src/core/safety/AGENTS.md` (docs)

Increment 5 source:
- `src/core/agent/reasoningPolicy.ts` (new, capability-based policy)
- `src/core/subagent/contracts.ts` (`supportsReasoningEffort`)
- `src/llm/client.ts` (capability + reasoning mapping + `ModelRuntimeConfig.reasoningPolicy`)
- `src/config/settings.ts` (`reasoning` setting, passthrough)
- `src/core/agent/events.ts` + `src/cli/commands/streaming.ts` + `src/cli/commands/runCommand.ts` (`reasoning_policy` safe event)

Increment 3 tests:
- `tests/core/completionController.test.ts` (evidence projection + leakage guard)
- `tests/cli/commands/runCommand.test.ts` (evidence in JSON envelope)
- `tests/cli/commands/streaming.test.ts` (turn_end evidence; status assertions → toMatchObject)

Increment 4 tests:
- `tests/core/missingExecutable.test.ts` (new)
- `tests/core/toolResults.test.ts` (bounded missing-executable diagnostic)

Increment 5 tests:
- `tests/core/reasoningPolicy.test.ts` (new, no network)
- `tests/config/settings.test.ts` (reasoning parse/preserve)

## Validation

Increment 1: typecheck ✅ · 1281/1281 ✅ · lint ✅ · build ✅
Increment 2: typecheck ✅ · 1294/1294 ✅ · lint ✅ · build ✅ · git diff --check ✅
Increment 3: typecheck ✅ · 1301/1301 ✅ · lint ✅ · build ✅ · git diff --check ✅
Increment 4: typecheck ✅ · 1309/1309 ✅ · lint ✅ · build ✅ · git diff --check ✅
Increment 5: typecheck ✅ · 1319/1319 ✅ · lint ✅ · build ✅ · git diff --check ✅

## Risks / unresolved

- Inc 2 risk (global budget inside prepareStep, ephemeral non-persisted control) RESOLVED — turn-wide caps enforced; recovery control is a synthetic `<haze_control>` stripped before conversation/session writes.
- Inc 3 evidence must stay bounded (no raw commands/output/credentials) and be additive to existing JSON/stream-JSON consumers.
