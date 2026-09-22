# Session retrospective — friction haze caused the model (2026-09-22)

**Status update (2026-09-22, later session): all six findings are now FIXED in this worktree.** Fix evidence per item is appended at the end of this file; validation: `tsc --noEmit` ✅, `eslint src/` ✅, `npm run build` ✅, full suite 1,800 passed / 0 failed (previously 1,781 passed / 1 failed), `bin/haze.js --version --verbose` ✅ after rebuild. The original findings are preserved below unchanged for the record.

Source: `~/.haze/sessions/85e26ea55fb3b14c/2026-09-22T18-41-32-616Z-d3d69c.jsonl` (405 entries; goal 1 = the code-review request, goals 2–3 = this retrospective request), plus `~/.haze/logs/` (empty for today: `--debug` was off) and live tool behavior observed in the transcript. Baseline `b53d4e9`, haze 1.2.1.

Session shape: 3 goals, 105 tool starts (118 readFile, 29 shell, 14 readToolOutput, 10 writeTasks, 10 subagent, 14 writeFile), 38 `sdk-step-boundary` rollovers, 0 compactions. Goal 1 ended **failed/blocked** despite a complete, validated-artifact deliverable; goal 2 failed with zero assistant output and the user re-sent the identical prompt.

## RT-01 — listFiles silently returned an empty repository (live TS-03)

**Priority:** P1 · **Confidence:** high — observed twice, then reproduced.

Goal 1's **first tool call** (`listFiles path="."`) returned `entries: []` for this fully populated checkout; the same happened for `listFiles /Users/deniz.okcu/.haze` in goal 2. Both result envelopes echo `"cursor": ""` — an empty-string cursor. Per `src/utils/fs.ts:36-42`, `cursor == null` enables collecting, but `''` does not, and with zero cursor segments the pre-cursor branch returns nothing (`:93-95`). The agent then fell back to `git ls-files` via shell — whose 13 KB output was capped, costing an extra `readToolOutput` retrieval. One schema-default bug cost ~3 tool calls at the most critical moment (initial discovery) and made the primary discovery tool look broken.

**Fix:** normalize `cursor: ''` to absent (or reject with a recoverable argument error) at the `listFiles` boundary. This upgrades TS-03 from "reproduced in a harness" to "broke the primary agent in production, twice."

## RT-02 — The completion gate rejected a truthful, complete review deliverable

**Priority:** P1 · **Confidence:** high — goal_end evidence in the ledger.

Goal 1 (intent: review) produced 7 report files and an honest summary, yet `turn_end` = `failed`, `goal_end` = `failed/blocked`, evidence `validationOutcome: "failed" (generic), validationAfterMutation: true, mutationCount: 7`. Mechanism: the four baseline checks the agent ran with `purpose=validation` (`npm test`, `release:verify`, `lint:knip`, launcher) all fail **pre-existing** in this checkout; writing 7 Markdown files counted as mutations that made those failures "unresolved"; the gate then refused the voluntary final. Nothing the agent could truthfully do inside a review-only scope would turn those checks green (fixing them requires either rebuilding dist or metadata changes it was not authorized to make). The agent had to argue its case in prose while the structured record says `blocked` — exactly the "prose can never satisfy the gate" inversion: here structure could never be satisfied either.

**Fix directions:** (a) distinguish baseline failures captured *before* the first mutation from regressions after it (red→green already has this concept — generalize it to non-fix intents); (b) don't mint validation debt for mutations that cannot affect the failing check (7 Markdown writes vs. a TypeScript test suite); (c) for review/report intents, treat documented-and-reported baseline failures as an acceptable terminal state, not `blocked`.

## RT-03 — Subagent fan-out failed 5× in ~1.6s with no usable diagnostic

**Priority:** P2 · **Confidence:** high — five `subagent_state` terminal events.

All five parallel reviewers returned `provider_error, usable: false` with an **empty deliverable**, each running <1s and serialized (`running: 1` throughout — the queued→started→terminal chain shows one at a time despite the concurrency profile). The capsule contained no provider error text, no retry hint, no "fall back to doing it yourself" guidance — the parent had to infer all of that and redo ~5 subsystem reviews serially. Cost: one wasted step + a materially longer session.

**Fix:** when a worker fails before any tool call, surface the provider error class in the capsule (bounded), and let the subagent tool result suggest the parent-side fallback (retry once / proceed inline). Also examine why workers serialized and whether a provider outage should short-circuit the remaining queue instead of burning 4 more admissions.

## RT-04 — Validation summaries hid the actionable detail, forcing handle round-trips

**Priority:** P2 · **Confidence:** high — 14 `readToolOutput` calls this session.

Concrete cases: `release:verify` summary said "10 failed tests" when the handle held **32** mismatches (the summary list is capped — an agent trusting it would undercount); `node bin/haze.js --version` stderr was reduced to "generic failed" with 158 chars omitted — one line of the most actionable text in the whole session; `npm test` similarly required a handle fetch. Retrieval works, but every round-trip is a full model step. Summaries should preserve the *first N distinct* failure lines (they are the diagnostic, not noise) and never truncate a sub-1KB stderr to a label.

## RT-05 — Goal 2 failed in 20s with zero output; user had to re-send

**Priority:** P2 · **Confidence:** high (occurrence), low (cause — undiagnosable from retained data).

Goal 2 (19:08:09–19:08:29): one successful `listFiles`, **no `message_end`, no timeout/retry events**, then `turn_end: failed`, `goal_end: blocked`. The user re-sent the identical prompt (goal 3 succeeded). Compounding gap: `~/.haze/logs/` has nothing from today (`--debug` off), so the silent failure cannot be diagnosed after the fact.

**Fix:** a turn that ends `failed` with no assistant output and no tool failure should carry an explicit finishCause/stopReason in the ledger (stream stall? rejected final? empty completion?), and turn-level failure metadata should be persisted without `--debug` so post-hoc analysis is possible.

## RT-06 — Out-of-workspace listFiles returns a success-shaped empty list

**Priority:** P3 · **Confidence:** medium.

`listFiles /Users/deniz.okcu/.haze` returned `ok`-shaped `entries: []` rather than a structured "path is outside the workspace" refusal. An agent that doesn't know the confinement rule concludes "directory is empty" and may report a false fact. (RT-01's cursor bug may also contribute here; both need the fix.) An honest refusal with the bless-path guidance is one structured result away.

## What worked (keep as-is)

- **38 step rollovers were invisible**: prompt-cache-preserving one-step SDK instances caused zero observable friction across a 39-step goal.
- **Session JSONL was complete enough for this exact retrospective** — goal ledger, tool starts, subagent states, and turn evidence all reconstructed cleanly. The audit trail is a real strength.
- **Deduplication never misfired**: 118 readFiles, no false duplicate suppressions observed.
- **Zero compactions needed** for a ~7.5 MB session file with heavy tool traffic.

## Priority order for fixing

1. RT-01 (one-line cursor normalization — highest value/effort ratio in this whole review).
2. RT-02 (baseline-vs-regression validation semantics; blocks honest review/report workflows).
3. RT-05 (persist turn failure causes).
4. RT-03/RT-04 (subagent diagnostics; summary first-distinct-failure preservation).
5. RT-06 (honest out-of-workspace refusal).

Cross-references: RT-01 → TS-03; RT-04 → related to TS-06 (also observed live: `pwd && git status --short && ls` lost two-thirds of its output to the git reducer during this session).

## Fix log (2026-09-22, later session)

| ID | Fix | Files changed | Regression tests |
| --- | --- | --- | --- |
| RT-01 | `walkDir` normalizes empty/whitespace cursor to absent | `src/utils/fs.ts` | `tests/utils/walkDir.test.ts` (empty+whitespace cursor = first page; concrete cursor still resumes) |
| RT-02 | `decideTerminalStatus` returns `complete` for a ready voluntary `stop` final even at a budget boundary, aligning with `classifyTerminalOutcome` | `src/core/agent/completionController.ts` | `tests/core/completionController.test.ts` (3 rows), `tests/cli/commands/streaming/attemptOutcome.test.ts`, `tests/cli/commands/streaming.test.ts` (boundary complete + boundary-without-final still fails) |
| RT-03 | Provider-error capsules carry the bounded provider message plus explicit retry-or-inline guidance; legacy `error` field keeps the raw message | `src/core/subagent/subagentRunner.ts` | `tests/core/subagent/subagentRunner.test.ts` (bounded 300-char message; non-Error throw; raw `error` preserved) |
| RT-04 | Validation summaries append up to three distinct first failure lines; failing-validation reduction keeps ≤800-char/≤12-line raw output inline before the handle hint | `src/core/validation/outputParser.ts`, `src/core/shellOutput/reducers/validation.ts`, `src/core/shellOutput/registry.ts` | `tests/core/validationParser.test.ts`, `tests/core/shellOutput/reducers/validation.test.ts` |
| RT-05 | New pure `describeTurnFailure`; `turn_end` carries an additive `reason` persisted in the session ledger without `--debug`; silent no-output stop adds a user-visible system message | `src/core/agent/completionController.ts`, `src/core/agent/events.ts`, `src/cli/commands/streaming.ts` | `tests/core/completionController.test.ts` (`describeTurnFailure` cases) |
| RT-06 | `listFiles` returns a structured `outside_workspace` refusal with recovery hint instead of a success-shaped empty listing | `src/llm/hazeTools.ts` | `tests/hazeTools/listFiles.test.ts` |

**Corrections to the original analysis (found while fixing):**

1. **RT-02's mechanism was misdiagnosed** in the original text. The session ledger shows goal 1 ended with `finishCause: "stop"`, tasks 5/5 completed, and `budgetBoundary: true` — so the trigger was `decideTerminalStatus` failing *any* budget-exhausted turn even when readiness was `ready` with a voluntary substantive final (an internal contradiction with `classifyTerminalOutcome`, which already classified that shape `goal-complete`). The "pre-existing baseline failure vs. regression" hypothesis below was wrong: the failed checks were pre-existing, but they were not the gate's reason — intent was `review`-classified (`not_applicable` validation via readiness path), and the budget boundary alone forced `failed`. The fix targets the real mechanism; the baseline-vs-regression distinction idea remains valid future work but was not needed here.
2. **RT-06 was a misattribution**: goal 2's `listFiles /Users/deniz.okcu/.haze` empty result was **RT-01 again** — the user prompt blessed the path, `prepareWorkspaceRead` resolved it via the bless set, and the empty-string cursor suppressed the entries. Out-of-workspace paths *without* blessing did already refuse, but through the generic error path; the fix adds the structured `outside_workspace` refusal shape for model-facing clarity. The honest-refusal improvement is kept; the "success-shaped empty listing outside the workspace" claim only held in combination with RT-01.
