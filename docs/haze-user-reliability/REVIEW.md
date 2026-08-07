# REVIEW.md

Cross-cutting review across Increments 1–5. Each required check is listed with
how it was verified. Review/fix cycles stayed within the cap of three.

## Required review checks

1. **Global budgets cannot reset across retries or recovery slices.**
   - `onStepEnd` accumulates `turnState.{stepsUsed,toolCallsUsed,toolOnlyStepsUsed}`
     turn-wide; a retry/recovery slice observes prior usage.
   - `prepareStep` enforces `turnState.toolCallsUsed >= turnBudget.toolCallLimit`
     and per-slice `recoverySlice.maxToolCalls`.
   - Each recovery slice is clamped via `clampSlice` to remaining budget.
   - Tests: `completionController.test.ts` "enforces the global budget across
     slices"; `streaming.test.ts` rescue/length scenarios.

2. **Recovery cannot loop.**
   - Credits are single-use (`lengthCreditUsed`, `rescueUsed`); controllers
     decline once used (`decideLengthRecovery`/`decideRescue`).
   - A recovery slice never proposes another (`!turnOptions.recoverySlice` guard
     skips recovery computation).
   - Repeated length finish terminates cleanly (test asserts exactly 2 calls).

3. **Abort always wins.**
   - `if (result.recovery && !abortController.signal.aborted)` before each slice.
   - Controllers decline when `state.aborted`; abort path sets
     `turnState.aborted = true`.
   - `decideTerminalStatus` returns `aborted` first.

4. **Routine turns do not incur extra model calls.**
   - Both recovery decisions decline on a substantive terminal outcome or a
     non-length/non-boundary finish. Test "a normal successful turn makes no
     extra recovery call" asserts `streamedMessages.length === 1`.

5. **Evidence never overclaims correctness.**
   - `deriveValidationOutcome` returns `stale` when a mutation follows a
     validation (does not claim `passed`). `passed` only when a validation is
     fresh after the latest mutation. Tests cover all five outcomes.

6. **Safe output cannot leak commands, tool input, tool output, or credentials.**
   - `TurnCompletionEvidence` is enums/booleans/counts only; leakage guard test.
   - `safeToolFailureDetails` exposes only a bounded `errorCode` + bounded
     `error`/`missingExecutable` (never raw stderr/command). Tests assert no
     secret/flag/stderr leakage.
   - Headless `tool_end` omits raw tool input/output (unchanged).

7. **Provider behavior is capability based.**
   - `supportsReasoningEffort` gates reasoning; derived from protocol
     (directOpenAI), never model name. `reasoningPolicy.test.ts` asserts no
     model-name branching.

8. **Settings preserve unknown fields.**
   - All settings Zod schemas use `.passthrough()`; `reasoning` added without
     dropping unknowns. Tests assert preservation across read/patch.

9. **No benchmark-specific behavior entered product code.**
   - No task names, verifier logic, fixtures, or context-keyed behavior. Missing
     dependency recovery is fully generic (no Git/Python/Docker special cases).

## Additional privacy/security/budget notes

- Recovery control is a synthetic `<haze_control>` message, applied to
  `requestMessages` only and stripped before `setConversation`/session writes —
  never persisted as a user message (same mechanism as existing ephemeral
  controls, covered by the existing "never durable conversation/events" test).
- Rescue restricts tools to mutation + validation-capable only (drops
  discovery/read/coordinate + all MCP); verified by test.
- `missingExecutable` diagnostic exposes only the executable name + a generic
  next step; system install is never performed (deferred).

## Validation summary (final)

- `npm run typecheck` ✅
- `npm test` (full) ✅ 135 files / 1319 tests
- `npm run lint` ✅
- `npm run build` ✅
- `git diff --check` ✅ (no whitespace errors)
