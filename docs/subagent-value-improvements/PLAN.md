# Subagent Value Improvements — Implementation Plan

**Planned:** 2026-07-31
**Target:** one coherent, compatibility-safe implementation of all F0–F13 items dispositioned **implement now** or **adapt and implement now** in `RESEARCH.md`.

## 1. Goal

Make `subagent` a disposable context-isolation boundary that also supports runtime-bounded fleet fan-out:

1. The parent sends a bounded, self-contained task capsule.
2. A fresh worker independently resolves applicable project instructions and receives only a mode-appropriate prompt/toolset.
3. Worker exploration stays private; the parent model receives only a compact truthful result capsule.
4. A turn-scoped coordinator enforces concurrency, deadlines, cancellation, provider settings, and conservative shared-workspace mutation rules for both normal and `/fleet` calls.
5. `/fleet` control text is ephemeral, while user intent, compact capsules, and final responses remain durable.
6. Explicit settings and per-run flags select profiles/worker models without provider/model inference or fallback.

## 2. Non-goals and explicitly deferred work

The implementation agent must **not** add:

- a structured `FleetPlan`, dependency graph, extra planning/aggregation model round, or `/fleet --auto`;
- semantic-review/LSP worker mode, MCP inheritance, skill inheritance, or recursive subagents;
- concurrent shared-tree mutation, patch-return workers, isolated worktrees, or transactional/disjoint-write claims;
- persistent worker threads, durable worker transcripts, or durable result handles;
- remote telemetry, pricing/cost estimates, paid-provider CI, or mandatory live-model evaluation;
- inferred cloud/local profiles or a first-configured-provider/model fallback.

`/fleet` remains parallel-only and model-decomposed in this release. Code, rather than fleet prose, owns queuing, concurrency, deadlines, cancellation, mode capabilities, and mutation serialization.

## 3. Resolved assumptions and owner decisions

These decisions are settled by `REQUEST.md` and the reconciled research; implementation should not reopen them unless a code-level blocker is found.

1. **Modes:** ship exactly `inspect`, `research`, `implement`, and `validate`. `--review` forces `inspect`. No semantic/MCP mode.
2. **Scope:** `scope` entries are workspace-relative path hints. Validate them with existing workspace path helpers; reject outside-workspace paths. URLs/concepts belong in `objective`.
3. **Worker model:** absent `subagents.workerModel` intentionally reuses the already explicitly active main model. A configured/per-run missing or ambiguous selector returns `policy_blocked`; it never falls back.
4. **Profiles:** built-ins are selectable suggestions, never inferred from provider name, endpoint URL, or localhost. With no selected profile, use a documented provider-neutral compatibility baseline.
5. **Mutation:** only one mutation-capable worker (`implement` or `validate`) may hold the workspace lease in a turn. Read-only workers may remain concurrent. Main-turn file mutation and bash share the same turn policy.
6. **Bash:** omit it from `inspect` and `research`. `validate` and `implement` are mutation-capable because scripts can write. Conservatively place every worker bash command, and every main bash command while another mutation owner exists, under the workspace lease; command classification is informational, not a sandbox.
7. **Retries:** configure bounded AI SDK provider-call retries. Never replay an entire worker after it may have mutated the workspace.
8. **Validation ordering:** coordinator admission prioritizes queued `implement` work before `validate` work submitted in the same parent step; validation receives the mutation lease only after earlier mutation work settles. Fleet guidance continues to tell the parent to submit final validation after implementation results. No claim is made about future tasks not yet submitted.
9. **Result handles:** reuse the existing process-scoped `toolOutputStore`; handles are optional, bounded, and non-durable. The compact deliverable must stand alone after resume.
10. **Telemetry:** keep bounded metrics in raw tool output, UI/accounting, session-safe events, and `--debug` logs only. Do not write remote telemetry or full private transcripts.
11. **Compatibility:** retain the tool name, temporarily accept legacy `{task, tools?, maxSteps?}`, retain top-level V1 result fields for raw consumers, and make all settings/events additive.
12. **Profile values:** centralize and validate them rather than scattering constants. Start with:

| Profile | Concurrency | Steps | Tool calls | Output tokens | Input estimate | Deadline | Provider retries |
|---|---:|---:|---:|---:|---:|---:|---:|
| compatibility baseline | 5 | 25 | 20 | 4,096 | 40,000 | 300s | 2 |
| `local-safe` | 1 | 16 | 12 | 2,048 | 20,000 | 300s | 0 |
| `local-throughput` | 2 | 20 | 16 | 3,072 | 24,000 | 300s | 0 |
| `cloud-balanced` | 3 | 25 | 20 | 4,096 | 40,000 | 180s | 2 |
| `cloud-fast` | 5 | 25 | 20 | 4,096 | 40,000 | 120s | 1 |

Mutation concurrency remains one in every profile. Custom profile values are bounded by exported hard minima/maxima. Summary output defaults to 4,000 characters. Step limits are min 4, default 25, max 50; accepted values are never silently clamped.

## 4. Data contracts, APIs, and migration

### 4.1 Task input

Add a flat preferred model-facing schema:

```ts
type WorkerMode = 'inspect' | 'research' | 'implement' | 'validate';

interface SubagentTaskInputV2 {
  objective: string;              // 1..1200 chars
  deliverable: string;            // 1..600 chars
  mode: WorkerMode;
  scope?: string[];               // <=12, each 1..240 chars
  acceptanceCriteria?: string[];  // <=8, each 1..300 chars
}
```

Runtime normalization creates `SubagentTaskCapsule` with a stable turn-local ID, validated scope paths, selected mode/profile, and no model-authored runtime policy. Temporarily accept legacy:

```ts
interface LegacySubagentInput {
  task: string;
  tools?: BuiltInToolName[];
  maxSteps?: number;
}
```

Legacy normalization rules are deterministic:

- `implement` if default-all or mutation tools were requested;
- `validate` for bash without mutation tools;
- `research` for fetch without mutation/bash;
- otherwise `inspect`;
- use `task` as objective and a fixed “return a concise self-contained result…” deliverable;
- a valid legacy `maxSteps` may lower, but never raise, the active profile cap;
- reject values outside the public min/max instead of clamping.

Keep the adapter and explicit deprecation tests for the 0.9.x-compatible release. Mark its removal as a future major/schema migration; do not add a removal task to this implementation.

### 4.2 Result and telemetry

Add core contracts:

```ts
type WorkerTermination =
  | 'completed' | 'no_output' | 'step_limit' | 'tool_limit'
  | 'deadline_exceeded' | 'cancelled' | 'provider_error' | 'policy_blocked';

interface SubagentResultCapsule {
  id: string;
  termination: WorkerTermination;
  usable: boolean;
  deliverable: string;
  changedPaths: string[];
  validation: Array<{command: string; ok: boolean}>;
  coverageGaps: string[];
  truncated: boolean;
  resultHandle?: string;
}

interface SubagentTelemetry {
  modelSelector: string;
  durationMs: number;
  queueMs: number;
  toolCallCount: number;
  toolCalls: Array<{name: string; summary: string; durationMs: number}>;
  usage: {inputTokens?: number; outputTokens?: number};
  estimates: {
    taskCapsuleTokens: number;
    initialInputTokens: number;
    privateContextTokens: number;
    resultCapsuleTokens: number;
    mainContextTokensAvoided: number;
  };
}

interface SubagentExecutionResult {
  capsule: SubagentResultCapsule;
  telemetry: SubagentTelemetry;
  // temporary V1 raw projection:
  status: 'ok' | 'error' | 'timeout' | 'cancelled';
  summary: string;
  toolCalls: SubagentTelemetry['toolCalls'];
  toolCallCount: number;
  tokens: {in?: number; out?: number};
  durationMs: number;
  error?: string;
}
```

Use AI SDK v7 `tool({toModelOutput})` to serialize only `result.capsule` into parent `responseMessages`. Raw execute/tool callbacks retain `SubagentExecutionResult` for UI/accounting. V2→V1 mapping:

- `completed`, `no_output` → `ok` (V2 `usable` remains authoritative);
- step/tool/deadline limits → `timeout`;
- cancellation → `cancelled`;
- provider/policy outcomes → `error`.

No-output is `usable: false`; exact final-step synthesis may be `completed`; truncation is an explicit field and marker; unavailable usage remains `undefined`, not zero. Derive changed paths and validation records from successful structured tool outputs, deduplicate/sort canonical workspace-relative paths, and never infer them from prose.

### 4.3 Runtime/profile APIs

Add provider-neutral core types:

```ts
interface WorkerRuntime {
  model: LanguageModel;
  selector: string;
  providerName: string;
  capabilities: ProviderCapabilities;
  requestOptions: ProviderRequestOptions;
}

interface SubagentExecutionProfile {
  name: string;
  maxConcurrency: number;
  maxSteps: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxSummaryChars: number;
  maxInputTokens: number;
  deadlineMs: number;
  maxRetries: number;
}
```

`SubagentCoordinator.submit(capsule, run)` returns exactly one terminal result. It owns a FIFO queue, stable IDs, global semaphore, mutation lane, deadline/parent-signal composition, queue timing, peak concurrency, and bounded events. Deadline source is recorded separately from parent cancellation. All leases release in `finally` on success, error, deadline, or cancellation.

Introduce a `TurnExecutionScope` assembled once per main turn and injected into both the main `HazeToolContext` and the `subagent` tool. It contains the coordinator and shared `WorkspaceMutationPolicy`; do not add mutable scheduler state directly to arbitrary AI SDK tool context fields.

### 4.4 Settings

Extend passthrough settings with:

```ts
interface HazeSubagentSettings {
  workerModel?: string;
  defaultProfile?: string;
  profiles?: Record<string, Partial<SubagentExecutionProfile>>;
  [key: string]: unknown;
}
```

Known fields are strictly bounded and malformed known values fail loudly. Add `updateSubagentSettings(patch)` that merges the nested `subagents` object and nested `profiles` entries while preserving unknown root/subagent/profile fields. Existing `updateSettings` stays source-compatible.

Unknown explicit profile names and invalid worker selectors produce actionable `policy_blocked` capsules. Per-run flags override settings for one turn only and are not persisted.

### 4.5 Turn/session migration

Keep existing normal turn callers working by adding an optional third argument rather than replacing the current API immediately:

```ts
runAgentTurn(value, displayValue?, {
  ephemeralControl?: string;
  subagentOverrides?: {profile?: string; workerModel?: string; maxConcurrency?: number; forceMode?: 'inspect'};
});
```

`value` is always the durable user content. Request assembly wraps `ephemeralControl` with the existing synthetic-control primitive on every retry, but conversation snapshots, `turn_start`/`turn_end.request`, and input history retain only `value`. Existing V1 session snapshots remain readable. New subagent tool results persist only model-facing capsules; `tool_end` session events slim raw subagent output to capsule plus bounded coordinator metadata.

## 5. Ordered implementation phases

### Phase 1 — contracts, budgets, isolated worker context, and truthful model boundary

1. Add canonical worker limits to `src/core/agent/budgets.ts`: task field limits, step/tool/output/summary/input/deadline/profile hard bounds, synthesis reserve, and compatibility baseline. Remove duplicate runner constants.
2. Create `src/core/subagent/contracts.ts` with modes, task/result/telemetry/runtime types, legacy normalization, V2→V1 adapter, deterministic termination helpers, and changed-path/validation aggregation guards.
3. Create `src/core/subagent/executionProfiles.ts` with the four named built-ins plus compatibility baseline, Zod-backed custom-profile merge/validation, and mode-to-capability maps. Fixed toolsets:
   - inspect: `listFiles`, `readFile`, `grep`, `readToolOutput`;
   - research: inspect + `fetch`;
   - implement: inspect + `editFile`, `replaceLines`, `writeFile`, `bash`;
   - validate: inspect + `bash`.
4. Create `src/llm/workerContext.ts`. For each task it must:
   - validate scope paths inside `process.cwd()` using shared workspace helpers;
   - call `readContextFiles(cwd)` fresh;
   - call `readScopedContextFilesForPath` for each validated scope using accumulated paths/signatures;
   - preserve loader order/precedence and deduplicate by displayed path/signature;
   - initialize loaded path/signature sets from exactly that bundle;
   - build mode prompt and toolset;
   - estimate task + prompt + project context + tool schemas using existing context-budget helpers;
   - return `policy_blocked` if mandatory instructions alone exceed the profile budget; never truncate applicable instructions.
5. Refactor `buildSubagentPrompt` in `src/llm/systemPrompt.ts` to accept mode/task boundary and include only worker identity, private-context/result rule, applicable tools/completion rules, project context, date, and cwd. Keep fleet/main transcript text out. Replace the main prompt's “two or more” rule with the concise direct/one/multiple invocation policy.
6. Refactor `runSubagent` to consume normalized capsule, `WorkerRuntime`, profile, and assembled context. Keep a single user message containing the bounded capsule (not parent messages), initialize `HazeToolContext` loaded paths/signatures, and use a shared helper in `prepareStep` to append pending scoped instructions while preserving accumulated messages.
7. Make synthesis budget-safe at min/default/max. Track whether stop came from final completion, step cap, tool-call cap, parent cancellation, deadline, provider failure, or input/policy rejection. Collect partial step usage in `onStepEnd`; preserve unknown usage.
8. Store an oversized complete deliverable through `storeToolOutput`, return a useful bounded synthesis plus `truncated: true` and optional handle, and never rely on the handle for core meaning.
9. Change `createSubagentTool` to expose the preferred bounded schema plus temporary legacy input, route through normalization, and define `toModelOutput` returning only the result capsule.
10. Update raw-result consumers to read `telemetry` first with V1 fallback: `src/cli/commands/streaming/turnRuntime.ts`, `src/cli/commands/formatters.ts`, and `src/cli/commands/streaming/toolGroupRenderer.ts`. Label token/context savings as estimates.
11. Special-case subagent outputs in `src/core/session/sessionSlimming.ts`: retain capsule and bounded scheduler metadata, remove telemetry/tool logs/private details from durable `tool_end`; confirm conversation snapshots already receive capsule through `toModelOutput`.

**Phase 1 files**

- Create: `src/core/subagent/contracts.ts`, `src/core/subagent/executionProfiles.ts`, `src/llm/workerContext.ts`.
- Change: `src/core/agent/budgets.ts`, `src/core/subagent/subagentRunner.ts`, `src/llm/systemPrompt.ts`, `src/llm/tools/toolContext.ts`, `src/core/session/sessionSlimming.ts`, `src/cli/commands/formatters.ts`, `src/cli/commands/streaming/turnRuntime.ts`, `src/cli/commands/streaming/toolGroupRenderer.ts`.
- Update contracts: `src/core/subagent/AGENTS.md`, `src/core/agent/AGENTS.md`, `src/llm/AGENTS.md`.

### Phase 2 — explicit worker runtime, settings/profiles, coordinator, deadlines, and mutation policy

1. Refactor `src/llm/client.ts` to export `ProviderRequestOptions` and a discriminated explicit model-runtime resolver. Preserve `modelWithConfig` for existing callers. Build `WorkerRuntime` from either the active explicit main selection or an explicitly configured/per-run selector; include `providerRequestSettings` unchanged.
2. Extend `src/config/settings.ts` with passthrough `subagents` schemas/types and `updateSubagentSettings`. Validate known nested numbers/names, merge custom profile fields over built-ins/baseline, and preserve unknown nested fields. Reuse `resolveModelSelector` in `src/config/providers.ts`; add only a formatting/helper change there if needed to return actionable missing/ambiguous details.
3. Create `src/core/subagent/subagentCoordinator.ts`:
   - bounded global FIFO semaphore and one mutation lane;
   - a microtask admission batch so same-step `implement` submissions precede `validate` submissions;
   - queued cancellation without provider invocation;
   - composed parent/deadline signals with source tracking;
   - stable task IDs, queue/duration/peak counters, and exactly one terminal event/result;
   - no whole-worker retry.
4. Create `src/core/subagent/workspaceMutationPolicy.ts` with reentrant owner tokens. A mutation-capable worker acquires the workspace lease for its complete run. Main edit/write tools and main bash acquire the same turn-scoped policy; a worker's internal tools reuse its owner token rather than deadlocking. Canonicalize path inputs with existing real/workspace path helpers before coordination/reporting. Release all leases in `finally`.
5. Extend `HazeToolContext` in `src/llm/tools/toolContext.ts` with a policy reference and owner token. Wrap actual edit/write execution and conservative bash execution in the policy; preserve existing mutation-stop, reread-after-failure, dedupe, and mutation-epoch behavior. Remove bash's unconditional read-only coordination assumption. Strict read-only worker modes never receive bash.
6. Add bounded subagent/coordinator event variants in `src/core/agent/events.ts` for queued, started, completed/cancelled and aggregate state. Fields are IDs/title preview/model selector/profile/timing/termination/counts only—no full capsule objective, provider secrets, transcript, or tool output.
7. Change `src/llm/requestContext.ts` to resolve settings/profile/runtime once and create one `TurnExecutionScope` before assembling main built-ins/subagent. Inject the same workspace policy into the main tool context through the turn caller and the coordinator into `createSubagentTool`. A blocked explicit profile/model still exposes the tool but returns actionable `policy_blocked` without invoking a provider.
8. Pass `providerOptions`, `headers`, explicit `maxRetries`, `maxOutputTokens`, composed `abortSignal`, and AI SDK timeout where applicable to every worker `generateText` call. Provider-call retries stay inside that call; mutation workers are never replayed by coordinator logic.

**Phase 2 files**

- Create: `src/core/subagent/subagentCoordinator.ts`, `src/core/subagent/workspaceMutationPolicy.ts`.
- Change: `src/config/settings.ts`, `src/config/providers.ts` (only if resolver diagnostics need a helper), `src/llm/client.ts`, `src/llm/requestContext.ts`, `src/llm/tools/toolContext.ts`, `src/core/subagent/subagentRunner.ts`, `src/core/subagent/contracts.ts`, `src/core/subagent/executionProfiles.ts`, `src/core/agent/events.ts`, `src/cli/commands/streaming.ts`.
- Update contracts: `src/config/AGENTS.md`, `src/llm/tools/AGENTS.md`, `src/cli/commands/streaming/AGENTS.md`.

### Phase 3 — ephemeral `/fleet`, explicit per-run controls, and durable-state safety

1. Add a typed optional `TurnExecutionOptions` to `src/cli/commands/commands.ts` and `src/cli/commands/streaming.ts`. Thread it through interactive callers in `src/cli/commands/chat.tsx`; keep normal/headless behavior unchanged when absent.
2. In `runAgentAttempt`, append only durable `value` to conversation and session events. Apply `ephemeralControl` to request messages with `withSyntheticControl` immediately before each attempt/retry. Strip it before `setConversation`, snapshots, and tool-history compaction.
3. Replace `FLEET_GUIDANCE` in `src/cli/commands/fleetCommand.ts` with a short control covering: parallel-only decomposition, compact V2 capsules, truthful aggregation, coordinator-owned scheduling, mutation serialization, and post-mutation validation. Remove model-authored wave sizes, “spawn all,” and soft concurrency promises.
4. Add a pure fleet argument parser supporting:
   - `/fleet --review <prompt>`;
   - `/fleet --profile <name> <prompt>`;
   - `/fleet --workers <provider:model> <prompt>`;
   - `/fleet --concurrency <n> <prompt>`;
   - `--` to preserve a prompt beginning with flags.
   Unknown flags, missing values, empty prompts, and out-of-hard-range concurrency show usage and start no turn. Do not add `--auto`.
5. Call `runAgentTurn('/fleet ' + originalPrompt, displayValue, {ephemeralControl, subagentOverrides})`; preserve the original invocation—not expanded guidance—in input history, active conversation, `turn_start`, `turn_end`, and snapshots. Retries receive the same ephemeral control.
6. Migrate formatter/accounting status truth to `capsule.termination` + `usable`; retain V1 fallback for older/raw mocked results. Show profile/model/concurrency and bounded queue/termination summaries without exposing private work.
7. Update `/help`, input suggestions, README, and static docs with one-worker context-isolation value, four modes, explicit profiles/model behavior, fleet flags, non-durable controls/handles, conservative mutation, and no implicit provider selection.

**Phase 3 files**

- Change: `src/cli/commands/commands.ts`, `src/cli/commands/streaming.ts`, `src/cli/commands/chat.tsx`, `src/cli/commands/fleetCommand.ts`, `src/cli/commands/commandHelp.ts`, `src/cli/chat/inputSuggestions.ts`, `src/cli/commands/formatters.ts`, `src/cli/commands/streaming/turnRuntime.ts`, `src/cli/commands/streaming/toolGroupRenderer.ts`, `src/core/agent/requestAssembly.ts` (only to expose/reuse a shared ephemeral-control helper), `src/core/session/sessionSlimming.ts`, `README.md`, `docs/index.html`.
- Update contract: `src/cli/AGENTS.md`.

### Phase 4 — mapped regression coverage and release confidence

Add tests with fake models, fake clocks/deferred promises, and temporary workspaces. No network credentials.

**Create**

- `tests/core/subagent/subagentCoordinator.test.ts` — queue, concurrency, deadlines, cancellation, terminal-event invariants, mutation lane, validation admission.
- `tests/core/subagent/executionProfiles.test.ts` — baseline/built-ins/custom bounds and no inference.
- `tests/core/subagent/workspaceMutationPolicy.test.ts` — reentrancy, canonical aliases, bash/workspace lease, abort/error release.
- `tests/llm/workerContext.test.ts` — fresh root/scoped context, unrelated parent context exclusion, signatures, tool diet, budget block.
- `tests/fixtures/subagentInvocationScenarios.ts` — deterministic direct/one/multiple cases for opt-in model evaluation; CI validates fixture shape and expected policy labels only.

**Extend**

- `tests/core/subagent/subagentRunner.test.ts` — V2/legacy schemas, captured single capsule message, no parent/fleet text, min/default/max budgets, synthesis, every termination, unknown partial usage, truncation/handle, changed paths/validation, `toModelOutput` capsule-only behavior, provider options.
- `tests/config/contextFiles.test.ts`, `tests/llm/toolContext.test.ts` — same precedence, scope sibling exclusion, exact loaded signatures, lazy refresh, mutation stop, shared policy.
- `tests/config/settings.test.ts`, `tests/config/providers.test.ts`, `tests/llm/client.test.ts` — passthrough nested patches, malformed profiles, active/specified model resolution, ambiguity/missing block, OpenAI/OpenRouter options reaching workers.
- `tests/llm/requestContext.test.ts`, `tests/llm/systemPrompt.test.ts` — one coordinator per turn, mode tools, concise single-worker policy, no fleet guidance.
- `tests/cli/commands/fleetCommand.test.ts`, `tests/cli/commands.test.ts` — all flags/errors, short ephemeral control, parallel-only behavior, no model call on invalid input.
- `tests/cli/commands/streaming.test.ts`, `tests/cli/turnRuntime.test.ts`, `tests/cli/formatters.test.ts` — V2-first truth, telemetry accounting, retries reapply control, raw callback compatibility.
- `tests/core/requestAssembly.test.ts`, `tests/core/sessionStore.test.ts`, `tests/cli/chat/sessionRecorder.test.ts` — active and resumed conversation/session/event state contains original `/fleet` invocation and task/result capsules only; no control prose, telemetry, or private worker messages.
- Relevant `tests/hazeTools/**` mutation/bash tests — main/worker lease sharing and no read-only claim for arbitrary bash.

## 6. Acceptance-criteria-to-test map

| AC | Required proof |
|---|---|
| 1. One context-heavy task may delegate | system/tool wording snapshots; preferred schema accepts one call; direct/one/multiple fixture |
| 2. Bounded capsule; no history/fleet guidance | runner request capture and schema boundary tests |
| 3. Same project-instruction policy; no unrelated parent scope | worker-context temp-tree precedence/scope/signature/lazy tests |
| 4. Lightweight mode prompts/tools | mode toolset and prompt-size/input-budget tests |
| 5. Capsule-only model context; telemetry out of band | AI SDK `toModelOutput`, streaming callback, and session tests |
| 6. Truthful outcomes | table tests for completed/no-output/step/tool/deadline/cancel/provider/policy |
| 7. Provider options and explicit worker model | captured generate options; active/alternate/missing/ambiguous selector tests |
| 8. Hard concurrency and deadlines | deferred-worker coordinator stress tests for normal and fleet-created calls |
| 9. Fleet guidance not durable | active conversation, retry, JSONL snapshot/event, and resume tests |
| 10. Read-only cannot mutate; conservative mutation/bash | mode schemas, shared mutation policy, canonical alias, release, and validation-order tests |
| 11. Explicit cloud/local profiles | profile parser/settings tests proving no endpoint/provider inference or fallback |
| 12. Boundary/coordinator/persistence/settings/status/mutation coverage | all suites listed in Phase 4 |
| 13. Help/docs | exact help/autocomplete tests plus README/static docs review |
| 14. Release checks | commands below, with environmental blockers recorded in `IMPLEMENTATION.md` |

## 7. Validation commands

Run focused checks after each phase:

```bash
npm run typecheck
npx vitest run tests/core/subagent tests/config/contextFiles.test.ts tests/config/settings.test.ts tests/config/providers.test.ts
npx vitest run tests/llm/workerContext.test.ts tests/llm/requestContext.test.ts tests/llm/systemPrompt.test.ts tests/llm/client.test.ts tests/llm/toolContext.test.ts
npx vitest run tests/cli/commands/fleetCommand.test.ts tests/cli/commands/streaming.test.ts tests/cli/turnRuntime.test.ts tests/cli/formatters.test.ts
npx vitest run tests/core/requestAssembly.test.ts tests/core/sessionStore.test.ts tests/cli/chat/sessionRecorder.test.ts tests/hazeTools
npm run lint
```

Final release confidence:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

Optional manual smoke checks may use only user-configured models: same active model, explicit alternate worker, `local-safe`, configured concurrency two, cancellation, strict review no mutation, invalid selector/profile block, provider options, mutation serialization, and final validation. Record them as optional; they do not gate CI.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Preferred/legacy schema union reduces local-model adherence | Put preferred schema/description first, keep legacy branch shallow, test generated schema, and mark adapter for later major removal. |
| AI SDK model/raw output behavior differs from assumptions | Integration-test `toModelOutput`, raw tool callback, and `responseMessages` with installed AI SDK 7 before migrating consumers. |
| Deadline and parent cancellation race | Track abort source in one helper, first source wins, fake-clock race tests, clear timers/listeners in `finally`. |
| Mandatory instructions exceed worker budget | Never drop/truncate policy beyond existing per-file cap; return actionable `policy_blocked` naming profile/context remedy. |
| Mutation lease deadlocks worker's own tools | Use reentrant owner token inherited by worker tool context; test nested acquisition and all failure paths. |
| Shared-tree worker reads become stale | Hold one lease for the complete implement/validate worker, serialize mutation-capable workers, and require settled-tree validation. |
| Bash classification creates false safety | Omit bash in read-only modes and conservatively coordinate all worker bash; document that this is coordination, not sandboxing. |
| Main and subagent tools receive different policy objects | Construct one `TurnExecutionScope` before all tools and assert object identity in request-context tests. |
| Provider retries repeat mutations | Use AI SDK request retries only; no coordinator replay. Keep low/zero retries in local profiles and bounded hard maximum. |
| Session still captures telemetry through raw callbacks | Special-case `subagent` in session slimming and assert serialized JSONL does not contain telemetry keys/tool summaries/control phrases. |
| Process-local handle expires after resume | Keep capsule deliverable useful and label handles non-durable in UI/docs. |
| Prompt-only fleet cannot enforce future dependency ordering | Preserve parallel-only contract, hard-enforce resources for submitted calls, prioritize same-step validation safely, and defer dependency scheduling explicitly. |
| Large cross-cutting change obscures regressions | Implement in the ordered phases, keep adapters active until all consumers migrate, and run focused suites at every phase before full validation. |

## 9. Rollback notes

- No destructive settings migration is required. Removing/ignoring `subagents` restores baseline behavior; unknown fields remain intact.
- Preferred capsules, V2 result fields, events, and turn options are additive. Keep legacy input/V1 raw projection until a later deliberate removal, so individual integration layers can be reverted without invalidating old sessions/tests.
- `toModelOutput` can be reverted independently to the V1 projection if an AI SDK incompatibility is found, though this temporarily restores parent-context telemetry; retain the capsule types/tests for a follow-up.
- Coordinator/profile wiring can be disabled by routing through the compatibility baseline, but do not restore unbounded concurrency. Mutation policy rollback must default to serialization, not unsafe parallel writes.
- Ephemeral fleet control can be reverted by applying a shorter synthetic control; never restore durable 6k-character guidance once persistence tests land.
- Existing JSONL sessions remain readable because no old entry shape is rewritten and new readers are tolerant. No rollback script is needed.
- `dist/` is regenerated only by `npm run build`; never hand-edit or include it as source rollback material.

## 10. Final implementation checklist

A single implementation agent should execute only this checklist, in order:

- [ ] Check `git status --short`; preserve proposal/workflow artifacts and unrelated edits; read nested `AGENTS.md` files for every touched subtree.
- [ ] Add worker budget constants and task/result/runtime/profile contracts.
- [ ] Add built-in/custom profile validation and legacy input/V1 result adapters.
- [ ] Add independent worker context assembly with root/scoped precedence, exact signatures, mode tools, and input policy block.
- [ ] Refactor worker prompt/runner for capsule-only fresh messages, pending scoped controls, truthful termination, partial usage, changed paths/validation, truncation/handles, and `toModelOutput`.
- [ ] Migrate UI/accounting/session slimming to V2-first with V1 fallback and bounded local estimates.
- [ ] Add explicit worker runtime resolution and pass provider options/retry/deadline settings.
- [ ] Add turn-scoped coordinator and reentrant shared workspace mutation policy; inject the same scope into main and worker tools.
- [ ] Enforce global concurrency, one mutation-capable worker, queued/active cancellation, truthful deadlines, conservative bash, and settled validation admission.
- [ ] Add passthrough `subagents` settings and nested-preserving patch behavior; block invalid explicit profile/model references.
- [ ] Add separate durable value, ephemeral control, and per-run override plumbing.
- [ ] Replace durable fleet prose with concise synthetic control and add `--review`, `--profile`, `--workers`, `--concurrency`, and `--` parsing.
- [ ] Add all Phase 4 deterministic tests and invocation scenario fixtures.
- [ ] Update nested contract docs, help, autocomplete, `README.md`, and `docs/index.html`.
- [ ] Run focused validation, then the complete release command sequence; document any environmental blocker.

**Excluded from this checklist:** structured/dependent fleet planning and `--auto`; LSP/MCP/skills in workers; concurrent mutation/worktrees/patch workers; durable handles/transcripts; remote telemetry/costing; paid/live-model gating.
