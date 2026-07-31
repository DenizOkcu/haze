# Subagent Value Improvements — Review

## Review round 1

**Verdict:** changes-required

The isolation boundary, explicit profile/model resolution, mode tool diets, AI SDK v7 `toModelOutput`, scoped context assembly, settings passthrough, ephemeral fleet control, session slimming, and documentation are directionally sound. However, runtime-owned hard limits are not actually hard in important failure cases, deadline/cancellation truth has races, and the claimed mapped test coverage is incomplete. These are acceptance-criteria failures, not nits.

### Security findings

1. **High — A provider/tool run that ignores abort defeats the deadline indefinitely and can retain a concurrency slot and workspace mutation lease.** `src/core/subagent/subagentCoordinator.ts:90-109` only aborts a signal at the deadline, then waits for `item.run(...)` to settle before resolving, decrementing `running`, clearing `mutationRunning`, and admitting queued work. AbortSignal is cooperative; an endpoint or tool that never settles leaves the turn wedged and, for implement/validate, can block all later workspace mutation. A repro racing a never-settling `run` against 40 ms remained `still-pending` with a 10 ms profile deadline.

2. **Medium — The hard tool-call budget can be exceeded by an arbitrarily large tool-call batch.** `src/core/subagent/subagentRunner.ts:151-169` checks the count only in the next `prepareStep`, after the prior step's calls have executed; `totalToolCalls` is merely incremented in `onToolExecutionEnd`. A model can emit more than `profile.maxToolCalls` in one step, causing all calls (including bash/edit calls in mutation modes) to execute and creating unbounded raw telemetry relative to the declared cap. The result is labeled `tool_limit` afterward at `src/core/subagent/subagentRunner.ts:180-186`, but the limit was not enforced.

3. **Medium — Retry attempts do not share the promised turn-scoped mutation/coordinator boundary.** `src/cli/commands/streaming.ts:131` assembles a new request context, coordinator, and `WorkspaceMutationPolicy` inside each attempt, while `src/cli/commands/streaming.ts:483-494` loops retries for one turn. Any prior-attempt execution that outlives stream failure/cleanup is outside the next attempt's lease and concurrency domain, allowing overlap and defeating conservative shared-tree coordination. The execution scope must be owned for the whole turn or old work must be conclusively terminated before a new scope is admitted.

No credential disclosure, path traversal, remote telemetry, or read-only-mode mutation path was found in the reviewed changes.

### Correctness and maintainability findings

1. **High — Deadline and cancellation semantics are neither hard nor race-safe.** In addition to the non-settling case above, `src/core/subagent/subagentCoordinator.ts:87-100` stores only `deadlineExpired`; parent abort does not record a first-wins source, and the deadline callback sets the flag even if parent cancellation already won. A slow aborting provider can therefore turn a user cancellation into `deadline_exceeded`. The coordinator catch path also maps every unexpected non-deadline exception to `cancelled` (`src/core/subagent/subagentCoordinator.ts:98-102`), even without a parent abort. This violates the requested distinctions among deadline, cancellation, provider/internal failure, and policy block.

2. **High — `maxToolCalls` is reporting-only, not a runtime cap.** Evidence is `src/core/subagent/subagentRunner.ts:151-169` and `:180-186`. This leaves AC8 and the plan's centralized hard tool-call-budget item incomplete.

3. **Medium — Coordinator fairness/FIFO is not preserved.** `src/core/subagent/subagentCoordinator.ts:70-76` uses `findIndex` to skip a blocked queued mutation and admit later read-only work. Continued read submissions can repeatedly bypass a queued implement/validate job while another mutation is active. This contradicts the planned FIFO/fairness contract and can starve settled-tree validation or implementation under sustained submissions. Preserve the deliberate same-batch implement-before-validate rule without allowing unbounded bypass.

4. **Medium — Structured validation evidence is overstated.** `src/core/subagent/subagentRunner.ts:69-73` records every bash result with a numeric exit code as validation, even when `validationSummary` is absent. Inspection commands such as `git status`, `ls`, or `pwd` therefore enter `capsule.validation` as if they were validation commands. Only classifier/parser-confirmed validation should populate this field (or the field must distinguish generic commands).

5. **Medium — Claimed termination and persistence coverage is incomplete.** The runner suite directly covers completion, empty output, step limit, cancellation, provider error, and policy block, but not hard tool-limit enforcement or deadline/cancellation races. `tests/core/subagent/subagentCoordinator.test.ts:67-74` uses a cooperative run that resolves on abort, so it cannot detect the hard-deadline defect. `tests/core/subagent/subagentRunner.test.ts:456-462` directly calls `toModelOutput`; it does not prove installed AI SDK v7 `responseMessages` contain only the capsule while raw callbacks retain telemetry. `tests/cli/commands/streaming.test.ts:273-283` checks one successful attempt, not retry reapplication plus durable resumed JSONL state. The plan's claimed all-termination, abort/deadline race, integration-boundary, retry/resume, and shared main/worker policy proof is therefore missing.

6. **Low — Pre-aborted submissions do not emit the claimed terminal event.** `src/core/subagent/subagentCoordinator.ts:37-39` resolves immediately without `onEvent`, while queued and active cancellations emit terminal events. This violates the stated exactly-one-terminal-event invariant and makes observability depend on cancellation timing.

### Required fixes

- [ ] Make active worker deadlines resolve terminally even when provider/tool code ignores AbortSignal; release coordinator admission state safely without permitting a still-running mutator to race later mutation.
- [ ] Track abort source first-wins and classify parent cancellation, deadline, provider/internal errors, and policy blocks truthfully across races.
- [ ] Enforce `maxToolCalls` before excess tool executions, including a single model step containing more calls than the remaining budget; keep raw telemetry bounded.
- [ ] Keep one coordinator/mutation domain for the full turn across retries, or prove and enforce complete prior-attempt quiescence before creating another domain.
- [ ] Implement starvation-safe coordinator admission while retaining documented implement-before-validate behavior.
- [ ] Populate structured `validation` only from genuine validation evidence.
- [ ] Add deterministic regressions for ignored abort, parent-abort/deadline races in both orders, single-step tool bursts, queue fairness, unexpected run errors, pre-aborted terminal events, shared scope across retry, and lease release/quiescence.
- [ ] Add an installed-AI-SDK integration test proving `toModelOutput` affects `responseMessages` while raw tool output remains available out of band.
- [ ] Add retry plus JSONL restore tests proving fleet control/telemetry/private worker data never becomes durable.

### Optional suggestions

- Keep worker-context path resolution explicitly rooted in the supplied session cwd rather than relying on `process.cwd()` equivalence; this will make the isolation contract less fragile for future SDK/session callers.
- Split coordinator abort/deadline composition into a small independently tested helper; the current promise chain combines admission, source tracking, terminal emission, and lease accounting.
- Consider making `coverageGaps` include a deterministic limit/error gap when termination is a limit but a partial deliverable is usable.

### Validation reviewed or run

- Reviewed all workflow artifacts, root and relevant nested `AGENTS.md` files, the complete tracked diff, and every untracked source/test file.
- Reviewed implementation-reported release checks: typecheck; 104 files/931 tests; lint; build; package dry-run.
- Ran focused suites: **13 files, 136 tests passed** covering subagents, worker context, settings, client/request context, tool context, fleet/streaming, and session store.
- Ran a small deadline repro with `deadlineMs: 10` and a never-settling worker; after 40 ms the coordinator result was still pending.
- Optional live provider smoke tests were not run; they are explicitly non-gating.

### Acceptance-criteria assessment

| AC | Assessment | Evidence / gap |
|---|---|---|
| 1. One context-heavy task may delegate | **Pass** | Main/tool guidance explicitly permits one substantial worker. |
| 2. Bounded capsule; no parent/sibling/fleet history | **Pass** | Bounded V2 schema and one JSON user message; runner capture excludes conversation/fleet text. |
| 3. Shared project-instruction policy without unrelated parent scope | **Pass** | Worker reloads root/scoped files and initializes signatures independently; focused sibling-exclusion test passes. |
| 4. Lightweight mode prompt/tools | **Pass** | Fixed inspect/research/implement/validate diets; read-only modes omit bash/mutation. |
| 5. Compact model result; telemetry out of band | **Pass in code, test gap** | AI SDK v7 hook is correctly defined and sessions slim raw events, but no end-to-end AI SDK `responseMessages` proof. |
| 6. Truthful distinct outcomes | **Fail** | Parent/deadline race and unexpected coordinator errors can be mislabeled; required table coverage is incomplete. |
| 7. Provider options and explicit worker model | **Pass** | Explicit resolver blocks missing/ambiguous selectors; request options reach worker generation. |
| 8. Hard concurrency and deadlines | **Fail** | Concurrency is bounded only while runs settle; deadline is cooperative, not hard; tool-call cap is not hard. |
| 9. Fleet guidance not durable | **Pass in normal path, test gap** | Synthetic control is stripped from conversation/events and reapplied per attempt in code; retry/resume JSONL proof is missing. |
| 10. Read-only non-mutation; conservative shared mutation/bash | **Partial** | Mode diets and shared policy are sound within one attempt; retry-created policy domains and non-quiescent deadlines break the full-turn guarantee. |
| 11. Explicit cloud/local profiles without inference/fallback | **Pass** | Built-ins/custom profiles are explicit; compatibility baseline is provider-neutral; invalid explicit names block. |
| 12. Required boundary/coordinator/persistence/settings/status/mutation tests | **Fail** | Multiple plan-mapped race, integration, retry/resume, hard-limit, and terminal-truth tests are absent. |
| 13. Help/docs updated | **Pass** | CLI help, suggestions, README, static docs, and nested contracts reflect the feature. |
| 14. Release checks | **Pass based on reviewed evidence** | Implementation records all required commands passing; focused review run also passed. |

### Claimed plan items actually missing

- Hard elapsed deadline independent of endpoint abort responsiveness.
- First-source-wins deadline/parent cancellation composition.
- Hard tool-call cap and consequently bounded tool telemetry.
- One execution scope for the entire turn across retries.
- FIFO/starvation-safe admission.
- Truthful validation aggregation.
- The plan's complete deterministic test matrix for all outcomes, races, AI SDK model/raw separation, retry/resume persistence, and shared-scope invariants.

Explicitly deferred items (`FleetPlan`/`--auto`, LSP/MCP/skills inheritance, worktrees/patch workers, durable handles/transcripts, remote telemetry/costing, paid/live-model CI) were not required by this review.

## Review round 2

**Verdict:** pass-with-nits

The complete diff and all untracked source/tests were reviewed independently. Every round-1 required fix is implemented and covered by focused regression evidence. There are no critical/high findings and no unresolved required changes. The hard-deadline design now correctly separates logical terminal delivery from physical settlement: abort-ignoring work is quarantined, retains coordinator concurrency and mutation ownership, and emits a later settlement event. Tool calls are capped at the actual execution boundary, retries reuse one turn scope, classifications are first-wins, validation evidence is parser-backed, and the installed AI SDK/JSONL boundaries are supported by tests.

### Security findings

No critical, high, or medium security findings.

- **Low — `src/core/subagent/subagentCoordinator.ts:54-61`: queued cancellation does not immediately rerun admission.** If a queued mutation at the head is cancelled while another mutation is active, already-queued reads behind it remain idle until some later submission or physical settlement invokes `admit()`. This does not bypass limits or permit unsafe overlap, but can unnecessarily delay safe read-only work—indefinitely if the active quarantined mutator never settles. This is a scheduling availability nit, not an acceptance-criteria or release blocker.

No credential disclosure, traversal, read-only mutation path, hidden model fallback, remote telemetry, or durable private-worker transcript was found.

### Correctness and maintainability findings

No required correctness findings.

- **Low — `src/llm/workerContext.ts:35-39`: scope validation still relies on process-cwd path helpers before applying the supplied session cwd.** Current CLI use keeps these equal, so reviewed behavior is correct. A future SDK/session caller with a different cwd could validate against the wrong root. This was an optional round-1 suggestion and remains a reasonable follow-up.
- **Low — `tests/core/sessionStore.test.ts:151-170`: retry and JSONL durability are proven by layered tests rather than one end-to-end recorder test.** Streaming tests prove retry control reapplication and scope identity; session tests prove written/restored state is slim. A future integration test joining both paths would reduce test-fixture assumptions, but the actual production boundaries were inspected and are sound.

### Explicit disposition of every round-1 required fix

- [x] **Logical deadline vs physical quarantine:** fixed. `submit()` resolves at the deadline even for ignored abort; `running`/mutation admission remain occupied until the underlying promise settles, with `terminal(execution: quarantined)` followed by `settled`.
- [x] **First-wins cancellation/deadline and truthful errors:** fixed. One `abortSource` wins; parent-first is `cancelled`, deadline-first is `deadline_exceeded`, unexpected rejection is `provider_error`, and worker-returned policy/provider outcomes remain authoritative when they settle first.
- [x] **Hard per-execution batch tool cap:** fixed. Wrapped tool `execute` synchronously consumes the budget before calling the underlying tool; excess same-batch calls are blocked and omitted from bounded telemetry.
- [x] **Retry-wide coordinator/mutation scope:** fixed. `runAgentTurn` creates one scope holder outside the retry loop and passes the same `TurnExecutionScope` to every attempt.
- [x] **Starvation-safe admission/fairness:** fixed for the required invariant. Admission examines the queue head; same-batch reordering is restricted to implement-before-validate and later reads cannot bypass an older blocked mutation.
- [x] **Truthful validation evidence:** fixed. Bash contributes validation only when a structured `validationSummary` is present; generic successful commands no longer qualify.
- [x] **Deterministic regressions:** fixed. Tests cover ignored abort, retained physical slots/leases, both race orders, unexpected rejection, pre-abort events, same-batch bursts, fairness, scope reuse, and validation filtering.
- [x] **Installed AI SDK model/raw split:** fixed. The real AI SDK v7 integration proves `responseMessages` contain the capsule without telemetry while the raw callback retains telemetry.
- [x] **Retry/JSONL durability:** fixed. Retry tests prove ephemeral control is reapplied with one scope; session write/restore tests prove original `/fleet` value and compact output survive without control prose, private tool detail, or usage telemetry.

### Required-fix checklist

- [x] No required fixes remain.

### Optional suggestions

- Call `admit()` after removing a cancelled queued item so newly unblocked work starts immediately.
- Root worker scope normalization explicitly in `session.cwd` rather than relying on `process.cwd()` equivalence.
- Add one recorder-level retry-to-JSONL integration test when touching session orchestration again.

### Validation

Reviewed the complete tracked diff and every untracked product/test file, plus all workflow artifacts and relevant nested `AGENTS.md` contracts.

Commands run in round 2:

- `npm run typecheck` — passed.
- focused round-1 regression set — **7 files, 88 tests passed**.
- focused profiles/context/settings/client/tool-context/fleet set — **6 files, 59 tests passed**.
- `npm run lint` — passed.
- `git diff --check` — passed.

Also reviewed the review-fix agent's successful full evidence: **105 files / 943 tests**, build, and package dry-run. Live provider tests were not run and remain explicitly non-gating.

### Acceptance-criteria assessment

| AC | Assessment | Round-2 evidence |
|---|---|---|
| 1. One context-heavy task may delegate | **Pass** | Main/tool guidance permits one substantial isolation worker. |
| 2. Bounded capsule; no parent/sibling/fleet history | **Pass** | Bounded V2 schema and one JSON worker message; no inherited conversation. |
| 3. Shared instruction policy without unrelated scope | **Pass** | Fresh root/scoped loading, sibling exclusion, signatures, and lazy controls. |
| 4. Lightweight mode prompt/tools | **Pass** | Fixed mode diets; inspect/research omit bash and mutation tools. |
| 5. Capsule-only parent context | **Pass** | Installed AI SDK test proves capsule-only `responseMessages` and raw out-of-band telemetry. |
| 6. Truthful distinct outcomes | **Pass** | First-wins races, no-output/limits/cancel/deadline/provider/policy classifications are represented and tested. |
| 7. Provider options and explicit worker model | **Pass** | Explicit resolution blocks missing/ambiguous selectors; options/retries reach worker generation. |
| 8. Hard concurrency and deadlines | **Pass** | Logical deadline returns promptly; physical slots remain retained; tool executions and concurrency are hard-capped. |
| 9. Fleet guidance not durable | **Pass** | Control reapplies on retry but is stripped from conversation/events; JSONL retains only durable invocation/capsules. |
| 10. Read-only non-mutation and conservative mutation/bash | **Pass** | Tool diets plus shared reentrant turn policy serialize mutation across workers, main tools, and retries. |
| 11. Explicit profiles without inference/fallback | **Pass** | Provider-neutral baseline, explicit built-ins/custom profiles, and blocking invalid references. |
| 12. Required test coverage | **Pass** | Focused deterministic coordinator, boundary, persistence, settings, status, and mutation suites pass. |
| 13. Help/docs updated | **Pass** | CLI help/suggestions, README, static docs, and nested contracts align. |
| 14. Release checks | **Pass** | Round-2 typecheck/lint/focused suites pass; reviewed full 943-test/build/package evidence passes. |

Explicitly deferred features were not treated as required.
