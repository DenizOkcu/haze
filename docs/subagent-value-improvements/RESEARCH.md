# Subagent Value Improvements — Codebase Research

**Research date:** 2026-07-31
**Reviewed package:** `@denizokcu/haze` 0.9.0, AI SDK `ai` 7.0.19
**Scope:** proposal reconciliation only; no product code was changed.

## 1. Request summary

The requested coherent feature makes `subagent` a disposable context-isolation primitive rather than only a parallel fan-out mechanism:

- the parent hands off a bounded, self-contained task capsule;
- the worker receives no parent/sibling conversation or `/fleet` control text;
- project instructions are independently resolved with the main agent's precedence, scoped discovery, and signature behavior;
- mode controls a small safe prompt/toolset;
- worker exploration remains private and only a compact truthful result enters parent model context;
- runtime, not prompt prose, owns model resolution, request options, concurrency, deadlines, and mutation policy;
- `/fleet` guidance is ephemeral;
- cloud/local profiles and worker-model selection are explicit;
- tests and user documentation prove the boundaries.

The proposal is directionally correct. The complete coherent implementation should include the isolation contract, truthful outcomes, provider parity, a turn-scoped coordinator, explicit profiles/model selection, ephemeral fleet control, conservative mutation policy, tests, and docs. It should **not** mechanically include speculative structured fleet planning, arbitrary MCP/LSP inheritance, remote telemetry, paid CI, or isolated worktrees.

## 2. Current architecture and behavior

### 2.1 Entry points and worker runner

- `src/llm/requestContext.ts` registers one `subagent` tool on every main turn and passes the active main `model`, the parent's accumulated `contextFiles`, and session metadata to `createSubagentTool`.
- `src/cli/commands/fleetCommand.ts` is not a scheduler. It prepends a roughly 6.3k-character `FLEET_GUIDANCE` user prompt and starts an ordinary turn. The model decomposes, launches calls, manages waves, and aggregates.
- `src/core/subagent/subagentRunner.ts` runs each task through a fresh non-streaming `generateText` call. Its `messages` array contains exactly one user task string, so main and sibling conversation histories are already isolated.
- Each call creates a separate `HazeToolContext`, catches its own errors, receives the parent abort signal, and uses a fixed built-in allowlist. Recursion, skills, LSP, and MCP are absent.
- Worker limits are local constants: 25 steps, 20 tool calls, 12 trailing tool-only steps, 4,096 output tokens, and a 4,000-character returned summary. Forced synthesis preserves accumulated messages through `withSyntheticControl`.

### 2.2 Current task and result boundaries

The tool currently accepts:

```ts
{ task: string; tools?: BuiltInToolName[]; maxSteps?: number }
```

This lets the model choose tools and a nominal budget. The schema advertises `maxSteps <= 50`, but runtime silently clamps to 25.

`runSubagent` returns the full `SubagentResult` as the model-visible tool output:

- `status`, summary, error;
- per-tool summaries and durations;
- token counts and total duration.

The final worker transcript is not returned, but telemetry still consumes parent model context. Empty output is reported as an `ok` fallback sentence, exact step-limit completion is labeled `timeout`, and summary truncation is silent.

### 2.3 AI SDK v7 boundary that should be used

The installed AI SDK 7 API directly supports the required model/UI split:

- a tool may define `toModelOutput({toolCallId, input, output})` and return a `ToolResultOutput` such as `{type: 'json', value: capsule}`;
- AI SDK's tool loop invokes `toModelOutput` when constructing the tool message for the next model step and `responseMessages`;
- tool execution callbacks and streamed `tool-result` parts retain the raw `execute` output;
- `generateText` supports `providerOptions`, `headers`, `maxRetries`, `timeout`, `abortSignal`, `prepareStep`, `onStepEnd`, and tool-execution callbacks.

Therefore the execution result can contain `{capsule, telemetry, legacy fields}` for UI/accounting compatibility while `toModelOutput` places only `capsule` in parent conversation and session snapshots. A second wrapper model call is unnecessary.

AI SDK v7 also warns that tool context should be treated as immutable because parallel calls can race. Haze already mutates its turn-scoped context for deduplication and lazy discovery. New shared scheduler/mutation state should be encapsulated in dedicated coordinator objects and not add uncoordinated mutation of the context shape.

### 2.4 Context-file loading

`src/config/contextFiles.ts` is the policy source:

- startup candidates are global `~/.claude/CLAUDE.md`, then `~/.haze/AGENTS.md`, then ancestor/root `CLAUDE.md` followed by `AGENTS.md` from filesystem root to cwd;
- both same-scope files are supplied, and prompt policy states that `AGENTS.md` wins;
- nested files below cwd are loaded by `readScopedContextFilesForPath` only for a touched subtree;
- signatures are `size:mtimeMs`; unchanged files are skipped and changed files are returned again;
- files are bounded to 20,000 characters and display paths are stable.

`src/llm/tools/toolContext.ts` drives lazy discovery, serializes concurrent discovery, queues `pendingContextFiles`, and stops a mutation when newly discovered scoped instructions must first be reviewed. The main loop injects pending files through a synthetic control in `streaming.ts`.

The worker currently receives the **parent's entire accumulated context array**, which can contain unrelated nested instructions. It also initializes only `inFlightToolCalls`, so already injected files/signatures are not registered in worker state. Worker `prepareStep` does not inject `pendingContextFiles` through the same control helper as the main loop, although individual tool outputs carry discovered instructions and mutation stops.

A worker context assembler should call the existing loaders afresh for the worker cwd, then load validated scope paths with `readScopedContextFilesForPath`, initialize exact path/signature state, and reuse a shared pending-context control helper. Do not duplicate precedence in a prompt.

### 2.5 Main-turn and session persistence

`runAgentAttempt` appends `value` as a durable user `ModelMessage`, calls `setConversation`, and the interactive session recorder immediately writes conversation snapshots. `displayValue` changes only terminal UI text.

Consequently `/fleet` currently persists the full synthetic guidance as:

- active conversation content;
- `conversation_snapshot` JSONL state;
- `turn_start` and `turn_end` event request text.

Existing `withSyntheticControl` / `stripSyntheticControls` behavior already provides the right primitive for ephemeral controls. The turn API needs separate durable user content and ephemeral control. Retries must reapply the control to the request while snapshots/events retain only the original `/fleet` invocation.

Session slimming bounds large tool results but does not specially remove subagent telemetry. Once `toModelOutput` is used, conversation snapshots naturally contain only task/result capsules. The `tool_end` session event should also retain only bounded capsule/scheduler metadata, while live UI/accounting and `--debug` logging may consume telemetry.

### 2.6 Provider/model behavior

- `modelWithConfig` resolves only an explicit active model or explicit override through `resolveModelSelector`; there is no first-provider/model fallback.
- `providerRequestSettings` produces OpenAI `providerOptions` (prompt cache key and text verbosity) and OpenRouter sticky-session headers.
- The main `ToolLoopAgent` spreads these settings. Workers receive only the model object and lose them.
- There is no worker selector, execution profile, hard coordinator, or elapsed-time deadline.
- AI SDK itself defaults request retries unless `maxRetries` is supplied. Whole-worker retries would be unsafe after mutations; profile retry policy should use bounded provider-call retries, not replay an entire mutating worker.

A typed provider-neutral `WorkerRuntime` should carry model, explicit selector, request options, and capabilities into core. Missing worker configuration should mean “use the already explicitly selected active model.” A configured but missing/ambiguous worker selector must return an actionable `policy_blocked` result, never silently use the main or first model.

### 2.7 Concurrency and mutation behavior

There is no shared semaphore. Multiple tool calls in one AI model step may execute concurrently with no runtime cap; the “at most five” rule exists only in `FLEET_GUIDANCE`.

Each worker has private mutation state. `runDedupedTool` prevents only concurrent same-string paths inside that context. It does not coordinate workers or canonical path aliases. Bash is treated as deduplicable/read-only despite being able to mutate any path.

The coherent initial safety design is:

- `inspect` and `research` omit bash and all mutation tools;
- `validate` has read tools plus bash but is treated as workspace-mutation-capable because tests/builds/scripts may write;
- `implement` has mutation tools and controlled bash;
- the turn coordinator permits concurrent read-only workers but grants only one mutation-capable worker lease at a time;
- the same turn-scoped workspace mutation policy is available to main built-ins so a parent mutation cannot race a leased worker;
- potentially mutating/unknown bash uses a workspace-wide lease; strict review mode has no bash;
- actual paths are canonicalized before path-level coordination, but declared paths remain hints rather than a security boundary;
- final validation occurs after mutation workers settle.

This is deliberately conservative. Parallel mutation in isolated worktrees or patch-return workers remains a future experiment.

### 2.8 Existing tests and observability

Existing tests provide useful foundations:

- `tests/core/subagent/subagentRunner.test.ts`: fresh messages, independent failures, abort propagation, synthesis history, caps, V1 statuses, summaries, usage, and schema;
- `tests/config/contextFiles.test.ts` and `tests/llm/toolContext.test.ts`: scoped selection, sibling exclusion, signatures, queued context, and mutation-stop behavior;
- `tests/llm/requestContext.test.ts`: capability assembly;
- `tests/llm/client.test.ts`: provider request options;
- `tests/cli/commands/fleetCommand.test.ts`: current prompt-only contract;
- `tests/core/requestAssembly.test.ts` and `tests/core/sessionStore.test.ts`: synthetic controls and durable slimming;
- streaming/formatter tests: raw tool-result UI, nested token accounting, and parallel rows.

Current nested usage accounting reads top-level `tokens` from the raw streamed output. That can remain as a compatibility path while formatters/accounting migrate to `telemetry`. No remote telemetry exists or should be introduced.

## 3. Proposal findings: disposition

| Finding | Disposition | Reconciliation and reason |
|---|---|---|
| **F0: parallel framing hides context isolation** | **Implement now** | Change main/tool guidance, add bounded capsule schema, and allow one substantial independent worker. This is the core user value. |
| **F1: concurrency/write safety are prompt promises** | **Adapt and implement now** | Add a turn-scoped hard coordinator and conservative mutation leases. Do not claim transactional/disjoint parallel edits. Structured fleet planning is not required for the first coherent implementation. |
| **F2: no explicit worker model/profile** | **Implement now** | Add optional explicit worker selector and validated profiles. Absence uses the explicitly active model; invalid configured selectors/profile names block rather than fall back. |
| **F3: provider request settings are lost** | **Implement now** | Pass typed `headers`/`providerOptions` and explicit identity in `WorkerRuntime`; capture them in tests. |
| **F4: no deadline; timeout conflates limits** | **Implement now** | Hard deadline through composed abort/AI SDK timeout; distinguish deadline, cancellation, step, and tool limits. |
| **F5: bash/mutation isolation is incomplete** | **Adapt and implement now** | Strict read-only modes omit bash; validate/implement are mutation-capable and serialized; unknown/mutating bash uses a workspace lease. Defer worktrees/patch workers. |
| **F6: fleet guidance is durable** | **Implement now** | Split durable request from ephemeral synthetic control and test active plus resumed session state. |
| **F7: prompt-only orchestration is weak for local models** | **Adapt now; defer extra planning protocol** | Shrink fleet guidance and let code enforce queue/concurrency/deadlines. A separate structured plan + aggregation model round is substantial speculative scope and not needed to satisfy current acceptance criteria. |
| **F8: tools are broad and narrow** | **Adapt and implement core modes** | Ship inspect/research/implement/validate profiles with fixed built-ins. Defer semantic-review LSP and approved MCP inheritance until capability/security/lifecycle design exists. |
| **F9: result semantics mislead** | **Implement now** | Add termination/usable/truncated fields, deterministic changed paths/validation, optional handle, and V1 adapter. |
| **F10: budget API disagrees with runtime** | **Implement now** | Move worker limits to `budgets.ts`; validate min/default/max; no silent clamping; safely reserve synthesis. |
| **F11: worker context is untailored** | **Implement now** | Independent scoped assembler, mode tool diet, exact loaded signatures, and input estimate that policy-blocks rather than dropping mandatory instructions. |
| **F12: observability cannot show value** | **Adapt and implement locally** | Emit bounded coordinator/worker telemetry and heuristic context estimates to UI/accounting/debug. No remote telemetry, monetary estimate, or unproven speedup claim. |
| **F13: normal/fleet instructions conflict** | **Implement now** | One concise coordinator-backed invocation contract; remove model-authored waves and “spawn all” requirements. |
| **F14: dependent fleet modes** | **Defer** | Preserve current conservative parallel-only `/fleet` semantics. Support explicit review/profile/model/concurrency overrides now; defer `--auto` dependency scheduling until structured planning is justified. |

### Contract-level disposition

- **C1/C5/C7 (fresh one-way private execution):** preserve and add regression coverage; existing runner already has the correct basic message boundary.
- **C2 (task capsule):** implement the flat V1 schema. Treat `scope` as validated workspace path hints; URLs/concepts belong in the bounded objective because they are not context-file paths.
- **C3 (shared instruction logic):** implement by composition of existing loaders and lazy-discovery code, not copied prompt prose.
- **C4 (minimal prompt/tools):** implement four core modes; do not add semantic/MCP modes yet.
- **C6 (result capsule):** implement with AI SDK v7 `toModelOutput`; keep raw bounded telemetry out of model context.
- **C8 (single-worker value):** implement in system/tool guidance and deterministic schema tests. Live model decision evaluations remain optional.

## 4. Recommended compatibility and migration design

### 4.1 Task input

Use the new flat model-facing schema:

```ts
{
  objective: string;
  deliverable: string;
  mode: 'inspect' | 'research' | 'implement' | 'validate';
  scope?: string[];
  acceptanceCriteria?: string[];
}
```

All string/array limits must be schema constants. IDs, tools, concurrency, deadline, model, and budgets are runtime-owned.

Temporarily accept legacy `{task, tools?, maxSteps?}` through a normalization adapter. Infer the least compatible mode (`implement` if mutation tools/default-all were requested, `validate` for bash-only, `research` for fetch, otherwise `inspect`) and only allow a legacy step request to lower the active hard cap. Do not expose arbitrary tool selection in the new contract. Mark adapter tests for deliberate later removal; avoid keeping a complex union indefinitely because it harms local schema adherence.

### 4.2 Result output

Internally return:

```ts
{
  capsule: SubagentResultCapsule;
  telemetry: SubagentTelemetry;
  // temporary V1 projection for formatters/accounting/API compatibility
  status; summary; toolCalls; toolCallCount; tokens; durationMs; error?;
}
```

Use `toModelOutput` to send only `capsule` to the parent model. Map V2 to V1 as follows:

- `completed` and `no_output` -> legacy `ok` (new consumers must use `usable`);
- step/tool/deadline limit -> legacy `timeout`;
- `cancelled` -> legacy `cancelled`;
- provider/policy block -> legacy `error`.

Update UI/turn truth to prefer V2 and retain V1 fallback. Do not infer no-output or truncation from prose.

### 4.3 Settings and profiles

Add a namespaced, passthrough-validated `subagents` object with optional `workerModel`, `defaultProfile`, and custom `profiles`. Add a focused nested patch helper so unknown nested fields survive updates; root `updateSettings` is only a shallow merge.

Provide built-in `local-safe`, `local-throughput`, `cloud-balanced`, and `cloud-fast` profiles, but activate one only by explicit settings or `/fleet --profile`. With no profile setting, use a documented provider-neutral compatibility baseline; do not infer profile from hostname/provider. A configured unknown profile or worker selector blocks subagent execution instead of silently using the baseline/main model.

The no-worker-model case is not fallback: it intentionally reuses the already explicitly selected active model and should display that selector.

### 4.4 Durable state

- Durable user content: original normal request or `/fleet <prompt>`.
- Ephemeral content: compact fleet control and per-turn profile overrides.
- Parent conversation: assistant tool-call capsule input plus `toModelOutput` result capsule.
- Session events: capsule and bounded scheduler state only.
- Live UI/accounting and `--debug`: bounded telemetry; never worker message/tool-result transcript.
- Result handles may reuse the existing process-scoped tool-output store and must be documented as non-durable.

## 5. Files/components likely to change

### Core/config

- `src/core/subagent/subagentRunner.ts` — split contracts/execution, truthful outcomes, V1 adapter, `toModelOutput` tool definition.
- New focused modules under `src/core/subagent/` — contracts, execution profiles, coordinator, deadline/abort and workspace mutation policy.
- `src/core/agent/budgets.ts` — canonical worker min/default/max limits and input/deadline bounds.
- `src/core/agent/events.ts` — additive bounded worker/coordinator events if needed.
- `src/core/agent/requestAssembly.ts` — reuse synthetic controls; likely no semantic change beyond helper use.
- `src/config/contextFiles.ts` — a shared scoped bundle helper or exported composition primitive.
- `src/config/settings.ts` — passthrough subagent settings schema/types and nested-preserving patch helper.
- `src/config/providers.ts` / `src/llm/client.ts` — explicit worker selector resolution and reusable runtime/request options.
- `src/core/session/sessionSlimming.ts` — retain subagent capsule rather than full telemetry in durable events.

### LLM/tool integration

- New `src/llm/workerContext.ts` (or similarly focused module) — independent context assembly, scope validation, mode toolsets, prompt/input estimate.
- `src/llm/systemPrompt.ts` — concise direct/one/multiple policy and mode-specific worker prompts.
- `src/llm/requestContext.ts` — create one coordinator/runtime scope per turn and wire worker runtime/profile/event sink.
- `src/llm/tools/toolContext.ts` and a shared scoped-control helper — initialize worker files/signatures, apply lazy updates, and coordinate mutations/bash.
- `src/llm/tools/bashTool.ts` — enforce mode/workspace policy rather than treating classification only as coordination metadata.

### CLI/session/docs

- `src/cli/commands/streaming.ts` — separate durable request from ephemeral control; share turn execution scope; account for V2 telemetry.
- `src/cli/commands/fleetCommand.ts` — concise ephemeral guidance and explicit flags/overrides.
- `src/cli/commands/commands.ts` — turn options type.
- `src/cli/commands/formatters.ts`, `src/cli/commands/streaming/turnRuntime.ts` — V2-first display/accounting with V1 fallback.
- `src/cli/commands/commandHelp.ts`, `src/cli/chat/inputSuggestions.ts` — user-facing behavior.
- `README.md`, `docs/index.html`, and relevant nested `AGENTS.md` contracts after behavior changes.

### Tests

- Extend `tests/core/subagent/subagentRunner.test.ts`; add coordinator/profile/mutation-policy tests.
- Extend `tests/config/contextFiles.test.ts`, `tests/config/settings.test.ts`, and provider/client tests.
- Extend `tests/llm/requestContext.test.ts`, `tests/llm/systemPrompt.test.ts`, and tool-context tests.
- Extend fleet, streaming, formatter, request-assembly, turn-runtime, and session-store tests.
- Add deterministic invocation scenario fixtures; live cloud/local evaluation remains opt-in.

## 6. Existing patterns to follow

- `readContextFiles` + `readScopedContextFilesForPath` for precedence, display paths, signatures, and bounded reads.
- `pendingContextFiles` + synthetic scoped controls for lazy instruction application and mutation pauses.
- `withSyntheticControl` / `stripSyntheticControls` for one-request non-durable controls.
- `contextBreakdown` / `estimateValueTokens` for cheap, explicitly heuristic token estimates.
- `storeToolOutput` for bounded process-scoped handles.
- `resolveModelSelector` and explicit active-model rules; never first-provider/model selection.
- `providerRequestSettings` spread directly into AI SDK v7 generation options.
- Zod `.passthrough()` plus private atomic settings writes; preserve unknown fields.
- UI-agnostic core coordinator with injected event sink; React/Ink remains in CLI/UI.
- Additive session/event/result migration with tolerant V1 readers/formatters.
- Fake models, temporary workspaces, deferred promises, and fake clocks for deterministic tests.

## 7. Constraints from project instructions

- Node >=22, strict TypeScript ESM, NodeNext imports with `.js`, ES2022 target.
- Do not edit generated `dist/`, lockfile without dependency changes, secrets, ignored runtime state, or unrelated untracked proposal artifacts.
- Core remains provider/UI agnostic; model-facing schemas belong in LLM-facing modules and settings persistence in config.
- No implicit provider/model and no user-facing provider/model environment variables.
- Malformed known settings fail loudly; patching preserves unrelated/unknown fields.
- File tools remain cwd-confined, `.gitignore` aware, and bounded.
- Session state remains JSONL and debug model logging remains `--debug` only.
- Context precedence/lazy/signature behavior must remain one shared policy.
- Public tool results, settings, sessions, slash commands, and help text require compatibility tests and docs.
- No remote telemetry or paid credentials in mandatory validation.

## 8. Risks and unknowns

1. **Scope schema migration:** a legacy/new Zod union may reduce local-model adherence. Keep the transition short and test generated JSON schema shape.
2. **AI SDK raw/model split:** `toModelOutput` is the correct v7 hook, but tests must prove raw streamed output still reaches accounting while `responseMessages` contain only the capsule.
3. **Deadline classification:** compose a worker-owned deadline controller with parent abort and track which source fired; do not classify every aborted SDK call as user cancellation.
4. **Partial usage:** collect completed-step usage through `onStepEnd`; some provider failures still expose no usage, which must be `unknown`, not authoritative zero.
5. **Mutation leases:** holding a whole-worker mutation lease prevents stale concurrent implementers but requires reentrant treatment for that worker's own tools and serialization of internal mutation/bash calls. Test abort/error lease release.
6. **Bash safety:** classifier coverage is not a sandbox. Strict review must omit bash; unknown commands in mutation-capable modes require a workspace-wide lease, not a read-only claim.
7. **Settings default:** preserve a documented provider-neutral compatibility baseline. Built-in cloud/local profiles must never be silently inferred; invalid explicit references must not fall back.
8. **Result handles:** current handles are process-local and non-durable. A resumed session may retain a handle string that no longer resolves; capsule text must remain useful without it.
9. **Context budget:** mandatory global/root/scoped instructions can themselves exceed the budget. Return `policy_blocked` with an actionable profile/context-file remedy rather than truncating policy.
10. **Main/worker coordination boundary:** request assembly currently creates the subagent tool before the main `HazeToolContext`. A turn execution scope should be constructed first and injected into both to avoid separate mutation domains.
11. **Fleet planning quality:** a hard coordinator cannot make a weak model produce a good decomposition. Structured planning is a possible later feature, but adding an extra planning and aggregation call now increases latency/cost and migration risk.
12. **Proposal owner-decision items:** the request's acceptance criteria settle conservative mutation and explicit profile/model behavior, but do not require dependent `--auto`, MCP inheritance, or experimental worktrees.

## 9. Recommended mergeable implementation phases

### Phase 1 — isolation and truthful model boundary

1. Define bounded task/result/telemetry contracts, mode tool maps, legacy input and V2→V1 adapters.
2. Move worker limits into `budgets.ts`; align min/default/max and forced-synthesis reason tracking.
3. Build independent worker context from existing loaders, validated workspace scopes, exact loaded signatures, and shared lazy scoped control.
4. Build concise mode prompts/toolsets; inspect/research cannot mutate.
5. Implement truthful termination, usable/truncated/handle, changed-path and validation collection.
6. Use AI SDK `toModelOutput` so only the capsule enters parent model context; retain raw telemetry for live UI/accounting.
7. Update normal prompt/tool guidance to allow one high-context-noise worker.

This phase is independently valuable: one worker becomes a real context-isolation boundary even before parallel scheduling changes.

### Phase 2 — provider-aware runtime, coordinator, and profiles

1. Introduce typed `WorkerRuntime` with explicit selector/capabilities/request options.
2. Resolve optional worker model explicitly; block missing/ambiguous configured selectors.
3. Add passthrough settings/profile schemas and nested-preserving patches; no cloud/local inference.
4. Add one turn-scoped coordinator with hard global concurrency, mutation-capable concurrency one, queued cancellation, stable IDs, deadlines, and bounded events.
5. Use AI SDK request options (`providerOptions`, headers, bounded `maxRetries`, timeout) in every worker.
6. Add shared main/worker workspace mutation lease and conservative bash handling.

This phase makes both normal and fleet-emitted calls resource-safe.

### Phase 3 — ephemeral `/fleet` and explicit controls

1. Extend turn invocation to carry durable content, ephemeral control, and per-run subagent overrides separately.
2. Replace long wave-management prose with concise decomposition/aggregation guidance; coordinator owns caps and queues.
3. Add focused `--review`, `--profile`, `--workers`, and `--concurrency` parsing; preserve parallel-only default behavior.
4. Ensure retries, active conversation, events, snapshots, and resume never retain fleet control text.
5. Migrate formatters/accounting to V2 and keep V1 fallback.

### Phase 4 — integration tests, docs, and release confidence

1. Add isolation, AI SDK model-output, context precedence/scope/signature, coordinator/deadline/cancel, provider parity, settings, mutation/bash, persistence, and truthful-status tests.
2. Add deterministic direct/one/multiple invocation fixtures without paid models.
3. Update help/autocomplete, README, generated/static docs source, and nested AGENTS contracts.
4. Run full release validation and optional manually configured cloud/local smoke tests.

### Deferred follow-ups

- structured two-model-call `FleetPlan`/dependency scheduler and `--auto`;
- semantic-review LSP and explicitly approved MCP capability inheritance;
- persistent fleet artifacts or durable result handles;
- remote telemetry/cost database;
- patch-return or isolated-worktree mutation workers;
- paid-provider CI or mandatory live-model evaluation.

## 10. Validation commands

Focused during implementation:

```bash
npm run typecheck
npx vitest run tests/core/subagent tests/config/contextFiles.test.ts tests/config/settings.test.ts
npx vitest run tests/llm/requestContext.test.ts tests/llm/systemPrompt.test.ts tests/llm/client.test.ts tests/llm/toolContext.test.ts
npx vitest run tests/cli/commands/fleetCommand.test.ts tests/cli/commands/streaming tests/cli/turnRuntime.test.ts tests/cli/formatters.test.ts
npx vitest run tests/core/requestAssembly.test.ts tests/core/sessionStore.test.ts tests/hazeTools
npm run lint
```

Final confidence:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

Optional manual checks should use user-configured models only: same-model worker, explicit alternate cloud worker, `local-safe` concurrency one, configured local concurrency two, cancellation, strict review non-mutation, invalid selector/profile block, and mutation serialization/final validation.
