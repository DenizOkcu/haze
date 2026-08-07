# PRODUCTION_READINESS.md

## Acceptance criteria status

| Criterion | Status |
|---|---|
| A recoverable output-length finish can still produce the requested artifact | ✅ Inc 2 length-continuation (test: length→continue→write→complete) |
| Work discovered near a tool boundary can be applied without increasing budgets | ✅ Inc 2 rescue (reserved slot 24; test: rescue saves value) |
| Normal successful turns have unchanged model-call behavior | ✅ Inc 2 (test: normal turn = 1 call; no recovery on substantive outcome) |
| Validation evidence distinguishes passed/failed/stale/absent/not-applicable | ✅ Inc 1+3 (`deriveValidationOutcome`; tests for all five) |
| Missing dependencies lead to bounded safe recovery or a precise blocker | ✅ Inc 4 (generic diagnostic; safe errorCode; system-install deferred) |
| Users can explicitly select supported reasoning depth without model-name logic | ✅ Inc 5 (capability-based `reasoning`; tests) |
| Existing headless consumers remain compatible | ✅ Inc 3 (additive `evidence`; existing fields unchanged) |
| No remote telemetry is introduced | ✅ (no network added; provider calls unchanged in shape) |
| Existing safety and workspace confinement remain intact | ✅ (no confinement changes; rescue restricts tools; safe events bounded) |
| Full validation passes | ✅ typecheck/test/lint/build/diff-check |
| Conditional checkpointing is justified or deferred | ⏸ Deferred (see below) |

## Increment 6 — conditional checkpointing: DEFERRED (justified)

The objective explicitly says: do not implement automatically; evaluate
Increments 1–3 first; defer if they solve the problem.

### Evaluation of the "no-artifact" failure modes

1. **Output truncation (length finish):** solved by Increment 2 — the
   length-continuation slice resumes and writes the artifact.
2. **Tool-only boundary stall with discovered work unsaved:** solved by
   Increment 2 — the rescue slice applies the deliverable.
3. **Context overflow mid-work:** already handled by Haze's existing
   `compactConversation` (compaction + embedded work state) and the turn-wide
   state that persists across the recovery slice.
4. **Step/tool budget exhaustion with no file written:** residual, but (a) it is
   rare for implementation work to exhaust 64 steps / 120 tool calls without any
   mutation, (b) Increment 3 evidence makes it observable (`failed` +
   `budgetBoundary` + `validationOutcome: absent`), and (c) a forced checkpoint
   would risk unwanted mutations and extra model calls — directly conflicting
   with "routine turns make no extra calls" and "avoid forcing mutations for
   answer/research/review/planning requests".

### Decision

Defer. The primary artifact-loss modes are addressed by Increments 1–3 plus
existing compaction. A forced-checkpoint heuristic carries real product risk
(unwanted mutations, extra calls, heuristic complexity) without a measured
remaining problem. If future dogfooding reveals a concrete, measurable
no-artifact case that compaction + recovery do not cover, Increment 6 can be
revisited with a work-state-progress-gated, implementation-only, once-per-turn
checkpoint. This deferral is the explicitly permitted outcome.

## Deferred product decisions (carried forward)

- **System-install permission model (Inc 4):** not implemented. The
  missing-dependency diagnostic asks for consent and reports a precise blocker;
  it never silently modifies a user-managed toolchain. A safe system-install
  consent flow is a separate product decision.
- **Reasoning on non-directOpenAI protocols (Inc 5):** remains disabled
  (observable as `effective: disabled`). Mapping additional protocols
  (OpenRouter, Anthropic-style) would require their concrete provider-option
  shapes; not guessed.

## Compatibility notes

- JSON/stream-JSON consumers: `evidence` and `reasoning_policy` are additive;
  existing `result`/`turn_end`/`tool_end` fields are unchanged. Old parsers that
  ignore unknown keys are unaffected.
- `TurnResult` gained optional `evidence`; callers destructuring `{status}`
  are unaffected.
- `ProviderCapabilities` gained `supportsReasoningEffort`; any external consumer
  constructing capabilities must add the field (internal `fallbackProvider…`
  helper updated).
- Settings: `reasoning` is optional; malformed values fail loudly (consistent
  with existing settings policy); unknown fields preserved.

## Privacy notes

- No raw commands, tool inputs/outputs, stderr, credentials, or model secrets
  appear in safe events or evidence.
- `reasoning_policy` events expose only level strings + a reason.
- No remote telemetry added.
