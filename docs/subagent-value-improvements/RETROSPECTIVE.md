# Subagent Value Improvements — Retrospective

**Completed:** 2026-07-31
**Outcome:** complete; G7 recommended pass

## What went well

- **The workflow corrected the product framing before implementation.** Research separated the core value—disposable context isolation—from `/fleet` parallelism, then reconciled F0–F14 and C1–C8 against the actual AI SDK v7 and Haze architecture instead of treating the proposal as an unquestioned checklist.
- **Planning made compatibility and deferrals explicit.** The plan preserved the legacy input and V1 raw projection, explicit provider/model selection, unknown settings fields, existing sessions, and conservative shared-tree mutation. Structured dependency planning, MCP/LSP inheritance, worktrees, durable transcripts, remote telemetry, and paid CI were clearly deferred rather than half-built.
- **The implementation covered a difficult cross-layer contract.** Worker capsules, profiles, request options, context assembly, scheduling, mutation policy, UI/accounting, session slimming, CLI flags, help, and tests were delivered coherently. The implementation log mapped changes and validation evidence well enough for fresh reviewers to continue without oral context.
- **Independent review added real value.** Round 1 did not accept a green test suite as proof. It built a never-settling-worker repro, inspected the execution boundary, and found acceptance-criteria failures in deadlines, tool budgets, retry scope, fairness, validation truth, and persistence evidence.
- **The fix/review loop worked as intended.** Round 1 findings became targeted runtime and regression changes; round 2 independently checked every required item. Logical terminal delivery plus physical quarantine is materially safer and more truthful than the first implementation.
- **Release readiness included privacy and packaging.** The final pass aligned the changelog, ignored `.pi-sessions`, inspected package contents, and reran the complete release sequence. This caught workflow-runtime privacy concerns that ordinary product tests would not.

## What caused friction

### Why round 1 passed tests but failed hard-limit review

The initial tests proved the implementation under **cooperative** dependencies, not under the adversarial conditions implied by “hard” limits:

1. **Deadline tests made the worker resolve when aborted.** The coordinator started a timer and aborted a signal, but still awaited `run()`. The fake run honored abort, so tests passed. A provider or tool that ignored `AbortSignal` never settled, leaving the result pending and retaining coordinator/mutation state indefinitely. The tests had verified cancellation propagation, not a hard elapsed-time terminal boundary.
2. **The tool-call limit was checked after execution.** Counting in `onToolExecutionEnd` and checking in the next `prepareStep` appeared correct for models emitting small batches. It could not stop one model step from emitting more calls than the remaining budget. The suite verified final classification, not prevention at the actual tool `execute` boundary.
3. **Retry tests treated attempts independently.** Request assembly created turn-scoped objects inside an attempt, but the logical turn could retry. Tests checked ordinary assembly and successful turns without asserting coordinator and mutation-policy identity across retries or lingering prior work.
4. **Outcome tests omitted race order and unexpected failures.** A boolean deadline flag was sufficient for simple cases but not parent-first vs deadline-first races; generic rejection could be mislabeled as cancellation. The missing first-wins invariant stayed invisible.
5. **Persistence and AI SDK tests stopped at local helpers.** Calling `toModelOutput` directly did not prove installed AI SDK `responseMessages` behavior, and separate synthetic-control/session tests did not prove retry plus JSONL restore together.

The broad suite therefore passed because it had good happy-path and cooperative coverage but weak **negative proof** for hard claims. “Abort requested,” “count reported,” and “helper returns capsule” were mistaken for “execution cannot violate the boundary.”

### Other friction

- The original dossier advised independently releasable phases, while the user requested all coherent findings at once. The reconciled plan handled this, but the large cross-layer implementation increased review load and made weak invariants easier to hide behind 931 passing tests.
- “Hard deadline” was initially underspecified. JavaScript cannot forcibly stop arbitrary in-process work or guarantee that a remote provider stops. The final design had to distinguish prompt logical completion from physical settlement and avoid falsely releasing real mutation/concurrency capacity.
- Mutation safety required one policy across main tools, workers, retries, bash, and abort-ignoring work. Attempt-scoped construction was locally tidy but globally wrong.
- The proposal contained broader ideas—dependency scheduling, semantic tools, path-level parallelism—that could have distracted from the safer minimum. Research and planning spent necessary effort separating implement-now behavior from speculative scope.

## Missed or weak gates

- **G2 plan actionable — weak hard-limit acceptance wording.** The plan said “hard deadline,” “exactly one terminal result,” and “hard tool-call cap,” but did not require adversarial proofs at the physical boundary: a never-settling run, an oversized same-step tool batch, and both abort/deadline race orders.
- **G3 implementation complete — over-relied on self-reported checklist coverage and green totals.** G3 should not have described deadlines/tool caps as complete without direct evidence that an uncooperative dependency and a single oversized batch cannot violate the intended semantics. The implementation note also listed every planned outcome as covered before those tests existed.
- **AC-to-test mapping was present but insufficiently precise.** “Coordinator deadline test” did not specify ignored abort; “all terminations” did not require race ordering or unexpected rejection; “AI SDK boundary” did not require the installed SDK; “persistence” did not require retry-wide scope plus restored JSONL.
- **G4 was the first effective adversarial gate.** This was ultimately successful, but hard-limit/security invariants should have been challenged before implementation was marked complete.
- **Production readiness appropriately accepted low nits.** Queued-head cancellation admission, session-cwd rooting, and a recorder-level integration test remain legitimate follow-ups, but round 2 correctly distinguished them from release blockers.

## Prompt and process improvements

1. **Define “hard” in observable layers.** Future plans should state separately:
   - logical terminal delivery deadline;
   - cooperative abort request;
   - physical execution settlement;
   - whether capacity/leases remain occupied while execution is quarantined.
2. **Require adversarial acceptance tests for every resource claim.** Include dependencies that ignore abort, never settle, reject unexpectedly, finish exactly at a race boundary, and emit all remaining-plus-one tool calls in one model step.
3. **Test at the enforcement boundary, not only accounting hooks.** A call cap must wrap `tool.execute`; a persistence boundary must inspect serialized/restored state; a model-output boundary must use the installed AI SDK; a retry-wide policy must assert object identity and behavior across attempts.
4. **Add a claim-to-proof table to implementation notes.** For each word such as hard, private, durable, explicit, FIFO, or read-only, cite the enforcing code boundary and the deterministic regression test. Do not mark checklist items complete from indirect tests.
5. **Make scope lifetime explicit in design prompts.** Identify whether state is call-, attempt-, turn-, session-, or process-scoped. Coordinators and mutation policies for this feature are logical-turn scoped; result handles are process scoped; durable capsules are session scoped.
6. **Ask review agents to construct counterexamples.** Preserve the round-1 review behavior: do not only read tests; create the smallest repro that would falsify each high-value invariant.
7. **Keep fresh-session artifact handoffs.** The markdown workflow worked well. Future artifacts should remain concise, but review prompts should explicitly distrust implementation coverage claims until independently reproduced.
8. **Prefer staged mergeability even when implementing coherently.** Build and validate isolation/model-output, then coordinator limits, then fleet persistence/mutation. This reduces the number of interacting invariants under review at once.

## Codebase-specific lessons

### AI SDK model output vs raw output

AI SDK v7 `toModelOutput` is the correct boundary for sending only `SubagentResultCapsule` into parent `responseMessages`, while raw `execute` output remains available to `onToolExecutionEnd`, UI, accounting, and debug consumers. A direct unit call to `toModelOutput` is not enough: use installed-SDK integration coverage because SDK message assembly is the product boundary. Preserve raw/model separation when changing formatters or persistence so telemetry never leaks back into model context.

### Cooperative abort and hard deadlines

`AbortSignal` is a request for cooperation, not process termination. Provider requests, tools, or in-process promises may ignore it. Haze can guarantee prompt **logical** `deadline_exceeded` delivery, but it cannot claim physical termination without an isolation mechanism. Abort source must be first-wins so parent cancellation, deadline, and provider failure remain truthful across races.

### Physical quarantine

When logical completion wins but execution remains alive, the execution must be quarantined. Its real global concurrency and mutation ownership stay occupied until physical settlement; otherwise a still-running mutator could overlap later work. Separate `terminal` and `settled` events make this distinction observable. An indefinitely quarantined worker may reduce availability, but that is safer than fictional lease release.

### Retry-wide scope

A retry is another attempt in the same logical turn, not a new safety domain. The same `TurnExecutionScope`, coordinator, and `WorkspaceMutationPolicy` must span retries so quarantined or lingering work from an earlier attempt remains visible and coordinated. Constructing these inside `runAgentAttempt` silently breaks the guarantee even if each individual attempt is correct.

### Context loading

Workers should call the shared context loaders afresh rather than copy the parent’s accumulated files. Exact loaded paths/signatures must initialize lazy discovery; applicable scoped instructions are mandatory and must not be truncated to fit a profile. Newly discovered instructions must retain mutation-stop behavior. A future API should root scope normalization in supplied `session.cwd`, not assume it equals `process.cwd()`.

### Persistence

Durability must be designed separately from display and live telemetry. `/fleet` keeps the original user invocation durable while synthetic control is reapplied per retry and stripped before conversation snapshots/events. Parent conversation stores task/result capsules only; `tool_end` JSONL uses bounded slimming; worker telemetry and private tool details remain non-durable. Process-local result handles and `.pi-sessions` are separate non-durable/private concerns and must be documented and excluded from packages/source control.

### Mutation, validation, and accounting truth

Read-only safety comes from omitted capabilities, not prompt wording. Bash is not inherently read-only and must share conservative workspace coordination in mutation-capable modes. Validation evidence must come from structured classifier/parser output, not any successful shell command. Likewise, tool budgets must be consumed before execution and telemetry must describe accepted calls only.

## Recommendations for the next iteration

1. Fix the low availability nit by rerunning admission after queued-head cancellation.
2. Root worker scope validation explicitly in `session.cwd` and cover differing process/session cwd.
3. Add one recorder-level retry-to-JSONL integration test joining the currently layered proofs.
4. Add a reusable adversarial-limit test harness for never-settling runs, ignored abort, race ordering, and oversized tool batches.
5. Keep structured dependency planning, richer worker capabilities, and isolated mutation as separate proposals; do not weaken the current quarantine or workspace-wide safety model to gain throughput.
6. Run optional representative cloud/local smoke tests when user-configured endpoints are available, focusing on abort responsiveness, schema/tool-call behavior, and profile concurrency rather than treating paid tests as CI gates.

## Final assessment

The workflow achieved the requested feature and, importantly, improved it after independent review disproved the first implementation’s hard-limit claims. The main process lesson is that green tests validate only the modeled environment: resource, isolation, and persistence guarantees require adversarial tests at their actual enforcement boundaries. With the round-1 fixes, round-2 review, release checks, and this retrospective complete, **G7 should pass and the overall workflow should be marked complete**.
