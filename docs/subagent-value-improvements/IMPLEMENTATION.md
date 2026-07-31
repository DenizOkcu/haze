# Subagent Value Improvements — Implementation

**Implemented:** 2026-07-31
**Status:** complete; ready for independent review

## Checklist coverage

All items in `PLAN.md`'s final implementation checklist were implemented:

- centralized bounded worker/task/profile budgets and V2 contracts;
- built-in/custom profiles, legacy input normalization, and V2→V1 raw projection;
- independent root/scoped/signature-aware worker context assembly and input policy blocking;
- fresh capsule-only worker messages, mode prompts/tools, pending scoped controls, truthful termination, partial usage, changed paths/validation, truncation/handles, and AI SDK `toModelOutput` capsule isolation;
- V2-first formatting/accounting and subagent-specific durable event slimming;
- explicit worker runtime resolution with provider options, retries, output limits, and no selector fallback;
- turn-scoped hard coordinator, deadlines/cancellation, one mutation lane, reentrant workspace mutation policy, and conservative bash coordination shared by main/worker tools;
- passthrough `subagents` settings and nested-preserving profile patches;
- durable value vs ephemeral fleet control/per-run overrides, including retry behavior;
- concise `/fleet` control and `--review`, `--profile`, `--workers`, `--concurrency`, and `--` parsing;
- deterministic boundary/coordinator/profile/context/settings/persistence/provider/UI tests and invocation fixtures;
- nested contracts, help, autocomplete, README, and static docs.

### Explicitly deferred/non-goals

Unchanged from `PLAN.md`: structured/dependent `FleetPlan` scheduling and `--auto`; LSP/MCP/skill inheritance; recursive/persistent workers; concurrent shared-tree mutation, patches, or worktrees; durable transcripts/handles; remote telemetry/costing; paid CI and mandatory live-model evaluation.

## Files changed

### Product source

- `src/core/agent/budgets.ts`, `src/core/agent/events.ts`
- `src/core/subagent/contracts.ts` (new)
- `src/core/subagent/executionProfiles.ts` (new)
- `src/core/subagent/subagentCoordinator.ts` (new)
- `src/core/subagent/workspaceMutationPolicy.ts` (new)
- `src/core/subagent/subagentRunner.ts`
- `src/core/session/sessionSlimming.ts`
- `src/config/settings.ts`
- `src/llm/workerContext.ts` (new)
- `src/llm/client.ts`, `src/llm/requestContext.ts`, `src/llm/systemPrompt.ts`
- `src/llm/tools/toolContext.ts`
- `src/cli/commands/{commands,chat,fleetCommand,formatters,streaming,commandHelp}.ts` / `chat.tsx`
- `src/cli/commands/streaming/turnRuntime.ts`
- `src/cli/chat/inputSuggestions.ts`

### Tests

- New coordinator/profile/mutation-policy/worker-context/invocation-scenario suites and fixture under `tests/core/subagent/`, `tests/llm/`, and `tests/fixtures/`.
- Extended runner, client, request-context, settings, streaming, fleet, formatter/accounting, tool-context, and session-store coverage.

### Documentation/contracts

- `README.md`, `docs/index.html`
- relevant nested `AGENTS.md` files under `src/cli`, `src/config`, `src/core/subagent`, `src/llm`, and `src/llm/tools`.

Proposal artifacts under `specs/002-subagent-value-improvements/` were preserved unchanged. `dist/` and `package-lock.json` were not source-edited.

## Code, data, prompt, UI, and docs summary

- **Code/runtime:** workers now execute through one turn-scoped coordinator with hard profile concurrency, queued/active cancellation, elapsed deadline signals, mutation prioritization, and exactly one terminal result. Main and worker mutation/bash share a reentrant workspace-wide lease.
- **Data:** preferred tool input is the bounded flat V2 capsule. Raw output contains capsule + bounded telemetry + V1 projection; only the capsule reaches parent model context. V2 terminations distinguish completion, no output, step/tool/deadline limits, cancellation, provider errors, and policy blocks.
- **Context/prompt:** workers load project instructions afresh, include only relevant scoped files, initialize exact path/signature state, lazily inject changed nested guidance, and use inspect/research/implement/validate tool diets. Main guidance now permits one valuable isolation worker.
- **Provider/settings:** worker model selection is explicit. Absence intentionally reuses the already explicit active model; invalid configured selectors block. OpenAI/OpenRouter request options are passed to worker generation. Profiles are explicit, bounded, passthrough-preserving settings.
- **CLI/session/UI:** fleet guidance is synthetic and non-durable; original `/fleet` text remains durable. Formatters/accounting prefer V2 truth/telemetry. Session tool events retain only capsules and bounded scheduler metadata.
- **Docs:** command flags, modes, profiles, context isolation, mutation behavior, non-durable handles, and no-fallback behavior are documented.

## Compatibility and migration behavior

- Tool name `subagent` is unchanged.
- The model-facing tool initially accepted legacy `{task, tools?, maxSteps?}` during migration. Field validation with a local OpenAI-compatible model showed that the resulting union schema caused empty `{}` tool calls, so the registered tool now exposes only the flat required V2 capsule. Direct `runSubagent(string, ...)` and top-level V1 result projections remain source-compatible.
- Top-level `status`, `summary`, `toolCalls`, `toolCallCount`, `tokens`, `durationMs`, and optional `error` remain on raw outputs for existing UI/API consumers.
- Existing normal/headless turn callers remain source-compatible because turn options are optional and appended to the positional API.
- Existing settings/session shapes remain readable. New settings/events are additive, unknown nested fields survive focused patches, and malformed known fields fail loudly.
- No settings migration or provider/model fallback was introduced.

## Deviations from `PLAN.md`

1. The mutation policy uses a **workspace-wide lease for all file mutation and bash**, rather than separate path-level parallel locks. This is a stricter safe implementation consistent with the settled one-mutation-worker decision; lexical changed-path reporting is normalized, while symlink/path aliases cannot bypass the workspace lease.
2. Deadline enforcement uses the coordinator's composed abort signal around the worker request rather than relying solely on AI SDK's `timeout` option. This records parent cancellation vs deadline deterministically and covers the complete worker call.
3. Coordinator telemetry is exposed through bounded state events plus raw worker telemetry rather than a larger fleet-run UI object. The deferred structured fleet planner means there is no scheduler-owned planned-task aggregate yet.

No implement-now behavior was dropped.

## Validation

Focused validation during development:

- `npm run typecheck` — passed.
- focused Vitest suites for subagents, worker context, invocation fixtures, settings, request context, client/provider options, fleet, streaming, accounting/formatting, sessions, and tool context — **209 tests passed** in the principal focused run; follow-up focused regressions also passed.
- `npm run lint` — passed.
- `git diff --check` — passed.

Final release sequence (2026-07-31):

- `npm run typecheck` — passed.
- `npm test` — passed: **104 files, 931 tests**.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm pack --dry-run` — passed: `@denizokcu/haze@0.9.0`, 269 files, 211.7 kB packed / 1.3 MB unpacked.

Optional live cloud/local smoke tests were not run because they require user-configured provider endpoints and are explicitly non-gating.

## Remaining risks/follow-ups

- Model decomposition quality remains prompt-driven and parallel-only until the explicitly deferred structured fleet planner exists.
- Workspace-wide serialization is intentionally conservative and may reduce throughput for disjoint implementation tasks.
- Result handles remain process-local and cannot be relied on after resume; capsules are designed to stand alone.
- Provider abort responsiveness ultimately depends on the configured endpoint honoring cancellation.
- Live cloud/local behavior should be smoke-tested voluntarily across representative configured models before broad rollout, without making paid credentials a CI requirement.

## Review-fix round 1 (2026-07-31)

### Required findings addressed

1. **Hard deadline / retained resources:** `SubagentCoordinator` now delivers a logical terminal result immediately when deadline or parent cancellation wins, even if the underlying run ignores abort. Such work is explicitly marked `execution: "quarantined"`; it continues consuming its real coordinator concurrency and mutation slot until physical settlement, followed by a distinct `settled` event. No hard resource release is claimed while work lingers.
2. **Abort and error truth:** abort source is first-wins. Parent-before-deadline remains `cancelled`; deadline-before-parent remains `deadline_exceeded`; unexpected run rejection is `provider_error`; worker-returned policy/provider outcomes remain authoritative. Pre-aborted work emits exactly one settled terminal event.
3. **Hard tool-call budget:** worker tools are wrapped at their actual `execute` boundary. Calls in one emitted batch synchronously consume the remaining budget; excess calls return a bounded blocked result without invoking the underlying tool. Accepted-call telemetry is capped and termination is `tool_limit`.
4. **One turn scope across retries:** `runAgentTurn` retains the first assembled `TurnExecutionScope` and supplies it to every retry. The coordinator and `WorkspaceMutationPolicy`, including quarantined work and held leases, therefore span the whole logical turn.
5. **Starvation-safe admission:** coordinator admission now examines the queue head instead of bypassing a blocked mutation. Implement-before-validate reordering is limited to those two modes within the same emitted batch; older queued work cannot be bypassed by later reads.
6. **Truthful validation evidence:** `capsule.validation` now accepts bash results only when a structured `validationSummary` exists. Generic commands such as `git status`, `ls`, or `pwd` no longer count as validation.
7. **Deterministic regressions:** added ignored-abort quarantine, logical-vs-physical settlement, retained lease, both abort/deadline race orders, unexpected error, pre-abort event, FIFO fairness, single-batch tool burst, validation classification, retry shared scope, and retry/JSONL durability coverage.
8. **Installed AI SDK boundary:** a real installed-AI-SDK v7 `generateText` integration test proves accumulated `responseMessages` contain only the compact capsule while `onToolExecutionEnd` retains raw telemetry out of band.
9. **Retry/JSONL durability:** retry tests prove ephemeral fleet control is reapplied to each request while one scope is reused. JSONL restore tests prove only the original `/fleet` value and compact capsule survive; synthetic fleet guidance, private worker tool detail, and usage telemetry do not become durable.

### Files changed in review-fix round 1

- Runtime: `src/core/subagent/subagentCoordinator.ts`, `src/core/subagent/subagentRunner.ts`, `src/core/agent/events.ts`, `src/llm/requestContext.ts`, `src/cli/commands/streaming.ts`.
- Contracts/docs: `src/core/subagent/AGENTS.md`, `README.md`, `docs/index.html`.
- Tests: `tests/core/subagent/subagentCoordinator.test.ts`, `tests/core/subagent/subagentRunner.test.ts`, `tests/core/sessionStore.test.ts`, `tests/llm/requestContext.test.ts`, `tests/llm/subagentToModelOutput.integration.test.ts` (new), `tests/cli/commands/streaming.test.ts`.
- Workflow: `docs/subagent-value-improvements/STATUS.md`, this implementation log.

### Validation and exact outcomes

- `npm run typecheck` — passed.
- `npm test -- tests/core/subagent/subagentCoordinator.test.ts tests/core/subagent/subagentRunner.test.ts tests/core/subagent/workspaceMutationPolicy.test.ts tests/llm/subagentToModelOutput.integration.test.ts tests/llm/requestContext.test.ts tests/cli/commands/streaming.test.ts tests/core/sessionStore.test.ts` — passed: **7 files, 88 tests**.
- `npm run lint` — passed.
- `npm test` — passed: **105 files, 943 tests**.
- `npm run build` — passed.
- `npm pack --dry-run` — passed: `@denizokcu/haze@0.9.0`, **269 files, 213.3 kB packed / 1.3 MB unpacked**.
- `git diff --check` — passed.

### Findings intentionally not addressed

No required round-1 finding remains unaddressed and there is no blocker. The three optional suggestions were intentionally not implemented because they are unrelated to the required fixes: worker cwd rooting needs a broader context-loader API decision; abort/deadline helper extraction would be refactoring without behavior gain after the coordinator rewrite; and synthetic `coverageGaps` for usable partial limit results changes capsule semantics beyond this review.

## Field-validation fix: local model emitted empty subagent inputs

A real `/fleet --review` run produced three `subagent` calls with `{}` input and AI SDK union-validation failures. The transitional union of the preferred capsule and legacy `{task, tools, maxSteps}` schema was the compatibility risk already identified in research. The registered tool schema now exposes one flat object with required `objective`, `deliverable`, and `mode` fields, field descriptions optimized for tool-calling models, and no `anyOf`/`oneOf` branches. Fleet control explicitly names the required fields and prohibits empty calls. Direct string-based runner compatibility and V1 raw result projection remain intact.

The next live run confirmed valid task inputs but exposed a second integration defect: `createSubagentTool` declared `contextSchema: hazeToolContextSchema`, while the real main turn intentionally supplies `toolsContext` only to built-in file/bash tools. AI SDK therefore rejected the subagent's undefined tool context before execution. The subagent tool does not consume `HazeToolContext`—it only uses the standard execution `abortSignal`—so the unnecessary runtime context schema was removed. The installed-AI-SDK integration test now intentionally omits per-tool subagent context, matching the real main turn and preventing regression.

A subsequent live run reached worker execution but the model's first three objectives exceeded the strict 1,200-character cap and required a repair turn. The schema now tolerates objectives up to a bounded 4,000 characters while tool/fleet descriptions explicitly request objectives below 1,000 characters and direct output-format detail into `deliverable`/`acceptanceCriteria`. This preserves lightweight normal behavior without rejecting otherwise valid verbose tool callers.

The same repository-wide review then showed the behavioral limit: broad workers consumed all 20 calls, two returned no deliverable, the parent retried broad work repeatedly, and a later pre-mapped retry exceeded the 12-scope-item cap. Worker prompts now state their concrete call/step budget and require early synthesis/partial coverage instead of exhaustive reads. Fleet control now requests one bounded structure lookup before broad reviews, focused scopes, and at most one materially narrower retry. The accepted scope ceiling is 32 while guidance still prefers 12 concise hints.

Validation: typecheck, lint, focused runner/fleet/request-context/installed-AI-SDK/system-prompt suites, full tests (105 files, 944 tests), build, package dry-run, and diff check pass after the field fixes.
