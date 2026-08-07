# RETROSPECTIVE.md

## What worked

- **Refactor-first foundation (Inc 1).** Moving completion policy into pure
  `core/agent` modules made recovery (Inc 2) and evidence (Inc 3) small,
  reviewable, and independently testable. The pure `decideTerminalStatus` /
  recovery controllers are table-testable with no provider/UI imports.
- **Turn-wide state as the single source.** Accumulating steps/tool calls/evidence
  across retries and recovery slices in one `TurnExecutionState` removed the
  per-attempt budget-reset bug class and made evidence honest.
- **Catching a latent bug during Inc 2.** `isBudgetExhausted` counted a `length`
  finish as exhausted, which would have made length-recovery unreachable. Split
  terminal `budgetReached` (counts length) from recovery's
  `hasRemainingRecoveryBudget` (step/tool only). The table tests caught it.
- **Work-state validation fix (Inc 1).** Treating an arbitrary `bash` call as
  validation was a real correctness bug (`ls` recorded as "passed validation").
  Now only classifier-confirmed commands count, with mutation/validation
  sequencing for staleness.

## Surprises / friction

- **Mock plumbing for recovery slices.** The streaming integration test mock
  needed per-call stream parts / step ends / tool sets to script length and
  rescue slices. Added `callStreams`/`callStepEnds`/`availableTools` to the mock
  (backward compatible).
- **Source plan absence.** The referenced report file did not exist; the
  objective's own roadmap was used as the authoritative spec (documented in
  REQUEST/RESEARCH). No benchmark results were used to derive requirements.

## Risks carried forward

- System-install permission model (Inc 4) and non-directOpenAI reasoning
  mapping (Inc 5) are deferred product decisions (see PRODUCTION_READINESS).
- Increment 6 (checkpointing) deferred by evaluation.

## What we would do differently

- Surface `TurnCompletionEvidence` from the very start of the recovery work —
  it made the "no overclaim" review trivial. In hindsight, defining the evidence
  shape in Inc 1 (even if unsurfaced) would have tightened Inc 2.

## Validation recap

typecheck ✅ · full suite 1319/1319 ✅ · lint ✅ · build ✅ · git diff --check ✅
across all implemented increments (1–5). Increment 6 deferred by evaluation.
