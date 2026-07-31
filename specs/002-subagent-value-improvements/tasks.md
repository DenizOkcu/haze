# Tasks: subagent value improvements

**Input:** [research.md](./research.md), [plan.md](./plan.md)
**Status:** proposed; no source implementation has been performed.

## Working rules for implementing agents

- Check `git status --short` before each phase and preserve unrelated edits.
- Read nested `AGENTS.md` files for every touched subtree.
- Never edit `dist/`.
- Keep each phase independently mergeable; do not combine this entire backlog into one PR.
- Preserve the existing public `SubagentResult` through an adapter until all consumers migrate.
- Provider/model selection must remain explicit. Never fall back to the first configured model.
- Settings patches must preserve unrelated and unknown fields and malformed settings must fail loudly.
- Add tests before or with each behavior change.

## Dependency map

```text
Phase 0 lightweight context-isolation contract
  └── Phase 1 truthful contracts
        ├── Phase 2 provider-aware worker runtime
        ├── Phase 3 coordinator
        │     ├── Phase 5 structured /fleet
        │     └── Phase 6 mutation coordination
        └── Phase 4 ephemeral control + profiles
              └── Phase 5 structured /fleet

Phase 7 UX/docs follows Phases 3–6.
```

---

## Phase 0 — lightweight spin-off context contract

**Goal:** make context isolation—not parallel fan-out—the foundational subagent behavior described in [context-isolation-contract.md](./context-isolation-contract.md).

- [ ] **T000A** Define bounded `SubagentTaskCapsule` and `SubagentResultCapsule` types following [invocation-plan.md](./invocation-plan.md).
  - Keep the model-facing V1 schema flat: objective, deliverable, mode, optional scope, and optional acceptance criteria.
  - Runtime enriches it with ID, validated capabilities, budgets, and context metadata; the LLM does not choose runtime policy.
  - Result fields: ID, termination, usable deliverable, changed paths, validation, coverage gaps, truncation, and optional bounded handle.
  - Add explicit size/count limits and Zod validation at the model-facing boundary.

- [ ] **T000B** Add a shared worker context assembler, preferably in a focused `src/llm/` module with injected filesystem/config collaborators where needed.
  - Independently resolve global and workspace ancestor/root instructions using the existing context-file loader and precedence rules.
  - Resolve task-scope instructions only for validated workspace `scopeHints`.
  - Do not initialize workers by copying the parent's accumulated `contextFiles` array.
  - Initialize loaded path/signature state from exactly the files included so lazy nested discovery and signature refresh behave like the main thread.

- [ ] **T000C** Build concise mode-specific worker prompts and toolsets.
  - Include identity/task boundary, applicable project instructions, relevant tool/completion rules, date, and workspace.
  - Exclude main conversation summaries, `/fleet` guidance, unavailable tool prose, and unrelated subtree instructions.
  - `inspect` must not include mutation tool schemas.
  - Enforce a worker initial-input budget without dropping applicable project instructions.

- [ ] **T000D** Change `runSubagent` to accept the task capsule/context bundle and prove that its model messages contain no main-thread or sibling messages.
  - Preserve one-way execution: a blocked worker returns to the parent rather than interacting with the user.
  - Private worker messages/tool results are discarded after completion except bounded debug logging under `--debug`.

- [ ] **T000E** Split worker completion into model-facing result capsule and out-of-band telemetry.
  - Parent model tool-result content must not include per-tool logs, retries, raw usage, or verbose timing.
  - UI/accounting/debug events retain duration, tool count/summaries, usage, and attempts.
  - Session persistence stores task/result capsules only, never the private worker transcript.

- [ ] **T000F** Update `src/llm/systemPrompt.ts` and the `subagent` tool description with the concise decision policy from [invocation-plan.md](./invocation-plan.md).
  - Permit a single substantial independent task when private exploration should materially exceed task + result capsules.
  - Keep guidance against trivial work, sequential dependencies, uncertain shared mutations, and work needing active user conversation.
  - Distinguish direct work, one isolation worker, and multiple independent workers; keep scheduling policy out of model instructions.
  - Remove “only two or more” and “spawn all in one step” wording.

- [ ] **T000G** Add isolation tests.
  - worker sees capsule only, no main/sibling history or synthetic controls;
  - global/root instructions use main-agent precedence;
  - relevant scoped instructions are included;
  - unrelated nested instructions loaded by the parent are absent;
  - touching a new subtree lazily discovers instructions and preserves mutation-stop behavior;
  - worker receives no fleet guidance;
  - inspect worker receives no mutation schemas;
  - parent model result excludes telemetry/tool logs;
  - UI accounting still receives telemetry;
  - persisted session excludes private worker messages.

- [ ] **T000H** Add context-isolation measurements to debug/accounting events: task capsule size, initial worker input estimate, private context estimate, result capsule size, and heuristic main-context tokens avoided.
  - Label estimates as estimates.
  - Do not add remote telemetry without a separate privacy decision.

- [ ] **T000I** Add invocation scenario fixtures covering direct vs one-worker vs multiple-worker decisions.
  - Include simple targeted read, large-log diagnosis, external-doc research, independent multi-axis audit, sequential refactor, user product decision, shared-file mutation, broad validation diagnosis, and known two-line edit.
  - Score decision correctness, capsule self-containment/size, copied-context absence, valid tool-call rate, useful result rate, and estimated main-context savings.
  - Keep paid/live model evaluations opt-in; run deterministic schema and boundary tests in CI.

- [ ] **T000J** Add a temporary adapter for legacy `{task: string}` calls while the model-facing schema migrates.
  - Convert legacy input into an internal capsule with an explicit generic deliverable.
  - Add deprecation coverage and remove only in a documented breaking or sufficiently migrated release.
  - Do not expose both forms indefinitely if the union harms local-model schema adherence.

**Phase 0 validation**

```bash
npm run typecheck
npx vitest run tests/core/subagent tests/llm/requestContext.test.ts tests/config/contextFiles.test.ts tests/core/session tests/cli/turnRuntime.test.ts
npm run lint
```

---

## Phase 1 — truthful worker contracts and budgets

**Goal:** fix correctness gaps without changing the fleet orchestration model.

- [ ] **T001** Move subagent step/tool/output/summary constants from `src/core/subagent/subagentRunner.ts` into `src/core/agent/budgets.ts` with names that distinguish default, minimum, and maximum values.
  - Update `src/core/agent/AGENTS.md` or `src/core/subagent/AGENTS.md` only if the contract changes.
  - Acceptance: no duplicate numeric worker budget constants remain in the runner.

- [ ] **T002** Align the `maxSteps` Zod schema and description with runtime behavior.
  - Choose and document a meaningful minimum greater than the reserved synthesis requirement.
  - Either support the advertised maximum 50 or change the schema maximum to the actual hard cap.
  - Acceptance: schema-accepted values are not silently clamped to a different value.

- [ ] **T003** Make forced synthesis safe at minimum/default/maximum budgets.
  - Ensure a low valid budget permits useful tool work before synthesis.
  - Ensure the terminal step remains available for a deliverable.
  - Tests: extend `tests/core/subagent/subagentRunner.test.ts` with min, min+1, default, max, and max+1 cases.

- [ ] **T004** Extend the Phase 0 result capsule with `WorkerTermination` and add a V2→V1 compatibility adapter.
  - Include at least `completed`, `no_output`, `step_limit`, `tool_limit`, `deadline_exceeded`, `cancelled`, `provider_error`, and `policy_blocked`.
  - Include `usable` and `summaryTruncated` in the model-facing capsule while retaining usage/timing/tool details only in out-of-band telemetry.
  - Acceptance: no consumer infers no-output or truncation from summary prose.

- [ ] **T005** Correct completion semantics in `runSubagent`.
  - Empty final output → `no_output`, `usable: false`.
  - A complete synthesis on the final permitted step must not be marked elapsed-time timeout.
  - Tool/step exhaustion must retain the produced summary but report its real termination reason.
  - Add a visible truncation marker/metadata when summary length exceeds the cap.

- [ ] **T006** Preserve partial usage and tool-call metadata on worker errors where the AI SDK exposes completed-step data.
  - If unavailable for a failure shape, report usage as unknown rather than authoritative zero.
  - Update `subagentTokenEstimate` and its tests to distinguish unknown from zero.

- [ ] **T007** Initialize each worker's `HazeToolContext.loadedContextFilePaths` and `loadedContextFileSignatures` from `options.contextFiles`.
  - Acceptance: an already injected root `AGENTS.md` is not rediscovered or used to stop the first mutation unnecessarily.
  - Add a scoped-context regression test.

**Phase 1 validation**

```bash
npm run typecheck
npx vitest run tests/core/subagent/subagentRunner.test.ts tests/cli/turnRuntime.test.ts tests/cli/formatters.test.ts
npm run lint
```

---

## Phase 2 — provider-aware worker runtime

**Goal:** make worker requests consistent with the selected provider and enable explicit worker-model routing.

- [ ] **T008** Define a provider-agnostic `WorkerRuntime` input containing model, explicit selector/identity, provider capabilities, and request options.
  - Avoid importing settings/UI modules into `src/core/subagent/`.
  - Inject the runtime from `src/llm/requestContext.ts`.

- [ ] **T009** Refactor `providerRequestSettings` types so the same settings can be passed to both `ToolLoopAgent` and worker `generateText` calls.
  - Acceptance: OpenAI prompt cache/text verbosity options and OpenRouter sticky-session headers are present in captured worker requests when supported.
  - Tests: extend `tests/llm/client.test.ts` and subagent request-capture tests.

- [ ] **T010** Add optional explicit `subagents.workerModel` settings and model resolution.
  - Resolution statuses must handle missing and ambiguous selectors exactly as `/model` does.
  - No setting means use the explicitly active model.
  - Invalid configured worker selector must produce an actionable error; it must not silently use another model.
  - Tests: settings parsing/patch preservation and provider/model ambiguity.

- [ ] **T011** Display/log the worker model selector in subagent/fleet metadata without exposing keys or secret provider settings.

**Phase 2 validation**

```bash
npm run typecheck
npx vitest run tests/llm/client.test.ts tests/llm/requestContext.test.ts tests/config/providers.test.ts tests/config/settings.test.ts tests/core/subagent/subagentRunner.test.ts
npm run lint
```

---

## Phase 3 — hard coordinator, deadlines, and events

**Goal:** enforce resource limits for both normal subagent tool use and `/fleet`.

- [ ] **T012** Create `src/core/subagent/subagentCoordinator.ts` as a UI-agnostic bounded queue.
  - Inputs: profile, abort signal, worker runner, event sink.
  - State: queued/running/terminal tasks, stable IDs, peak concurrency.
  - Guarantee: active workers never exceed `maxConcurrency`.

- [ ] **T013** Compose parent abort with per-worker deadlines.
  - Prefer a small tested abort-signal helper.
  - Cancel queued tasks without starting them.
  - Distinguish parent cancellation from deadline expiration.
  - Acceptance: a stalled fake model reaches `deadline_exceeded`; abort returns control promptly.

- [ ] **T014** Add bounded, abort-aware retries for explicitly retryable provider errors.
  - Retry count comes from profile.
  - Respect retry hints when available and cap delay.
  - `local-safe` defaults to no retry storm.
  - Record attempts and retry events.

- [ ] **T015** Route `createSubagentTool.execute` through the turn-scoped coordinator.
  - `assembleRequestContext` must create one coordinator/execution scope per main turn, not one per tool call.
  - Normal single calls and parallel calls share hard limits.

- [ ] **T016** Define core coordinator events: queued, started, retrying, completed, cancelled.
  - Include task ID/title, model selector, attempt, elapsed time, and termination; exclude full prompts/secrets.
  - Add CLI adapter without importing Ink into core.

- [ ] **T017** Add deterministic coordinator tests in `tests/core/subagent/subagentCoordinator.test.ts`.
  - concurrency 1/2/5;
  - more tasks than capacity;
  - out-of-order completion;
  - one failure does not collapse siblings;
  - abort with queued and active tasks;
  - worker deadline;
  - retry then success/exhaustion;
  - every task gets exactly one terminal outcome.

**Phase 3 validation**

```bash
npm run typecheck
npx vitest run tests/core/subagent tests/llm/requestContext.test.ts tests/cli/commands/streaming
npm run lint
```

---

## Phase 4 — ephemeral fleet control and execution profiles

**Goal:** reduce context cost and provide explicit cloud/local operating modes.

- [ ] **T018** Extend the turn API so command handlers can pass:
  - durable user content/display value;
  - ephemeral turn guidance/control;
  - optional execution profile overrides.
  - Do not overload a single string with all three concerns.

- [ ] **T019** Change `/fleet` to persist only the original invocation/prompt and result, not `FLEET_GUIDANCE`.
  - Reuse synthetic-control stripping or a dedicated ephemeral instruction field.
  - Tests must inspect active conversation and serialized session JSONL after a fleet turn.
  - Acceptance: the phrase `You are running the /fleet command` is absent from durable state.

- [ ] **T020** Define and validate `SubagentExecutionProfile` in core/config layers.
  - Fields: mode, max concurrency, steps, tool calls, output tokens, summary limit, deadline, retry limit, optional explicit worker model.
  - Set conservative hard maxima to prevent malformed settings from creating unbounded work.

- [ ] **T021** Add suggested `local-safe`, `local-throughput`, `cloud-balanced`, `cloud-fast`, and `implementation-safe` profiles.
  - A suggestion becomes active only through explicit user configuration/selection.
  - Do not infer performance capacity solely from localhost or provider name.

- [ ] **T022** Add focused `/fleet` flag parsing for at least `--review`, `--profile <name>`, `--workers <provider:model>`, and `--concurrency <n>`.
  - Unknown/malformed flags show usage without starting a model turn.
  - Keep raw user prompt intact after `--` if supported.
  - Update command help/autocomplete/tests.

- [ ] **T023** Create capability profiles and construct a minimal worker toolset per mode.
  - `inspect`: no edit/write tools.
  - `semantic-review`: inspect + available read-only LSP tools.
  - `research`: inspect + fetch; MCP remains separately approved.
  - `implement`: mutation tools + controlled bash.
  - `validate`: bash/read, no edits.
  - Recursion remains impossible.

- [ ] **T024** Add a worker input estimate/budget before provider invocation.
  - Reduce tool schemas/context first.
  - If still too large, return `policy_blocked` with an actionable reason.
  - Add constrained-context fake-model tests.

**Phase 4 validation**

```bash
npm run typecheck
npx vitest run tests/cli/commands/fleetCommand.test.ts tests/cli/commands.test.ts tests/llm/requestContext.test.ts tests/config tests/core/session
npm run lint
```

---

## Phase 5 — deterministic `/fleet` plan and scheduling

**Goal:** replace model-managed waves with validated scheduler-owned execution.

- [ ] **T025** Define a Zod `FleetPlan` schema and pure validator.
  - Validate unique IDs, bounded task count, dependency references, acyclic graph, capability names, instruction/output lengths, and declared paths.
  - Reject duplicate/conflicting declared writes for concurrently ready mutation tasks.

- [ ] **T026** Implement a fleet planning model call that returns `FleetPlan`.
  - Keep prompt concise and task-focused.
  - Use one bounded repair attempt for malformed structured output.
  - Return an actionable planning failure after repair exhaustion.
  - Record plan usage separately from worker usage.

- [ ] **T027** Implement dependency-aware scheduling on top of `SubagentCoordinator`.
  - Start only tasks whose dependencies completed successfully/acceptably.
  - Mark blocked dependents explicitly when prerequisites fail.
  - Hard concurrency applies across all ready tasks and waves.

- [ ] **T028** Implement structured aggregation from `SubagentResultV2[]`.
  - Every planned task appears exactly once with terminal status.
  - No-output/truncation/coverage gaps are explicit.
  - Aggregator cannot relabel failed/no-output tasks as clean success.
  - Keep a deterministic non-model formatter available for planning/aggregation failure.

- [ ] **T029** Support modes:
  - default parallel-only: decline when fewer than two independent tasks;
  - `--auto`: run parallel ready tasks and dependency phases;
  - `--review`: force read-only capabilities.

- [ ] **T030** Reduce `FLEET_GUIDANCE` to the minimal planning contract or remove it once code owns scheduling.
  - Remove statements that are no longer model responsibilities.
  - Align `subagent` tool description with coordinator behavior; remove “spawn all in one step” if misleading.

- [ ] **T031** Add end-to-end fake-model fleet tests.
  - valid two-task plan;
  - seven tasks with hard concurrency below seven;
  - nonparallel plan;
  - mixed dependencies;
  - malformed plan then repair;
  - malformed plan exhaustion;
  - one worker failure and blocked dependent;
  - no output/truncated result;
  - abort;
  - local-safe serialization;
  - durable history excludes control text.

**Phase 5 validation**

```bash
npm run typecheck
npx vitest run tests/cli/commands/fleetCommand.test.ts tests/core/subagent tests/cli/commands/streaming tests/core/session
npm run lint
```

---

## Phase 6 — mutation coordination and integration

**Goal:** make implementation fleets materially safer.

- [ ] **T032** Add a turn/fleet-scoped shared mutation coordinator using canonical workspace paths.
  - Actual `editFile`, `replaceLines`, and `writeFile` calls acquire locks.
  - Same-path mutations serialize or fail with a structured recoverable policy result.
  - Prevent symlink/path spelling aliases from bypassing locks.

- [ ] **T033** Define bash policy per worker mode.
  - Strict review mode omits bash initially unless a conservative read-only command policy is available.
  - Potentially mutating bash in implementation mode acquires a workspace-wide mutation lock.
  - Do not continue treating arbitrary bash as read-only for mutation epoch/coordination.

- [ ] **T034** Add post-worker integration reconciliation.
  - Collect actual changed paths.
  - Reread the final tree after all mutation workers.
  - Detect undeclared/shared changes and report them.
  - Run one configured/recommended validation stage against the settled tree, not concurrently against partial states.

- [ ] **T035** Default mutation-capable fleet concurrency to one until isolation/patch application is implemented and proven.
  - Read-only workers may still run concurrently.
  - Mixed review + mutation plans must honor separate resource/mutation constraints.

- [ ] **T036** Add mutation tests.
  - same canonical path, different spellings;
  - symlink alias confinement;
  - disjoint direct file writes;
  - bash workspace-wide lock;
  - abort releases locks;
  - worker crash releases locks;
  - validation starts only after mutations settle;
  - changed-path mismatch is visible.

- [ ] **T037 (optional follow-up)** Prototype patch-return or isolated-worktree workers behind an experimental flag.
  - Write a separate design note first covering cleanup, ignored files, untracked files, merge conflicts, platform support, and session recovery.
  - Do not make this the default in the initial coordinator release.

**Phase 6 validation**

```bash
npm run typecheck
npx vitest run tests/core/subagent tests/hazeTools tests/llm/tools tests/cli/commands/fleetCommand.test.ts
npm run lint
```

---

## Phase 7 — terminal value reporting, docs, and release confidence

**Goal:** let users understand progress, resource use, and whether the fleet helped.

- [ ] **T038** Render scheduler-owned queued/running/retrying/terminal states with stable task titles and IDs.
  - Keep output bounded for large plans.
  - Preserve current no-token-stream behavior for worker internals.

- [ ] **T039** Add final fleet metadata: planned/completed counts, peak concurrency, wall time, summed worker time, token totals, model selector(s), attempts, and termination counts.
  - Call summed-worker-time/wall-time a utilization/parallelism indicator, not proven speedup.
  - Do not estimate monetary cost without trustworthy model pricing.

- [ ] **T040** Extend debug logs/events/session slimming for coordinator events and V2 results.
  - Avoid persisting full task prompts, secrets, or unbounded summaries.
  - Ensure flush behavior remains ordered.

- [ ] **T041** Update user documentation:
  - `README.md` cloud/local guidance and examples;
  - `docs/index.html` command/profile behavior;
  - `/help` and autocomplete;
  - current spec contracts/quickstart or a superseding spec note.

- [ ] **T042** Add an opt-in benchmark harness using fake or user-supplied models.
  - Cases: read-only review, repository survey, two independent edits, malformed tool caller, stalled endpoint.
  - Report wall time, task success, tokens, and concurrency; do not require paid credentials in CI.

- [ ] **T043** Run full release confidence checks.

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

- [ ] **T044** Perform documented manual smoke tests (when models are available).
  - one capable cloud model, same-model workers;
  - cloud parent + explicitly selected cheaper worker model;
  - local-safe concurrency 1 against Ollama/LM Studio/compatible endpoint;
  - local-throughput configured concurrency 2;
  - abort active fleet;
  - review mode cannot mutate;
  - mutation fleet serializes writes and validates final tree.

Record model/server versions, context limits, hardware only when voluntarily supplied, and observed outcomes. Do not generalize one model's behavior to all local models.

---

## Minimum valuable release cut

If scope must be reduced, ship this subset first:

1. T000A–T000G (lightweight context-isolation contract; T000H may follow).
2. T001–T007 (truthful worker outcomes and budgets).
3. T008–T009 (provider request parity).
4. T012–T017 (hard coordinator and deadlines).
5. T018–T019 (ephemeral fleet guidance).
6. T020–T023 (`local-safe`, `cloud-balanced`, read-only review mode).
7. T038–T041 (observable behavior and docs).

This cut first realizes the disposable spin-off-agent value, then materially improves cost/resource control and read-only fleet reliability without yet attempting safe concurrent implementation.

## Definition of done for the overall initiative

- A worker receives a bounded task capsule, no main/sibling conversation history, and no fleet guidance.
- Worker project context is independently assembled with the same instruction precedence, scoped lazy discovery, and signature refresh behavior as the main agent.
- Unrelated parent-loaded subtree instructions do not enter worker context.
- Only the result capsule enters the parent model context; private worker messages and telemetry do not.
- A single context-heavy independent task may use a subagent, while trivial/coupled tasks remain in the main agent.
- The configured concurrency cap is hard-enforced for normal and fleet-spawned workers.
- Every task has a scheduler-owned terminal result.
- Worker and fleet deadlines are real elapsed-time controls.
- Local-safe runs one worker at a time and uses a reduced context/tool profile.
- Cloud users can explicitly select a worker model and see aggregate usage.
- Provider-specific request options reach workers.
- Fleet control prompts do not persist in chat/session history.
- Read-only fleet mode cannot use mutation tools.
- Mutation fleets coordinate actual writes, conservatively handle bash, and validate the settled tree.
- No-output, truncation, budget exhaustion, dependency blocking, cancellation, and provider errors are truthfully distinct.
- Full typecheck, tests, lint, build, and package dry-run pass.
