# Plan: provider-aware, deterministic subagent orchestration

**Date:** 2026-07-31
**Input:** [research.md](./research.md)

## 1. Goal

Increase the measurable user value of subagents for both cloud and local OpenAI-compatible models without expanding the native tool surface unnecessarily.

The primary goal is **disposable context isolation**: a main agent creates a compact task capsule, a fresh worker performs noisy work in its own lightweight context using the same project-instruction discovery policy, and only a compact result capsule returns. Parallel `/fleet` scheduling is built on top of this primitive.

A successful implementation will make worker behavior:

- **isolated:** no main/sibling conversation or unrelated loaded context enters the worker;
- **lightweight:** task-specific project instructions, prompt, tools, and token budget;
- **result-only:** private tool/model history is discarded and observability metadata stays out of the parent model context;
- **predictable:** code enforces concurrency, deadlines, cancellation, and result states;
- **economical:** users explicitly choose worker models/profiles and can see aggregate usage;
- **local-friendly:** safe low-concurrency defaults, compact prompts, and graceful behavior for weaker tool callers;
- **workspace-safe:** read-only review is first-class, and parallel mutations are coordinated;
- **testable:** context boundaries and `/fleet` plan/schedule/result boundaries are explicit rather than relying only on prose.

## 2. Non-goals

- Do not allow recursive subagents.
- Do not silently pick a different provider/model.
- Do not expose all MCP/skill tools to workers by default.
- Do not claim transactional edits until isolation or patch application actually provides it.
- Do not build a distributed job system or persistent background daemon.
- Do not remove the simple model-facing `subagent` tool; improve its execution substrate.

## 3. Proposed architecture

### 3.0 Task capsule → independently assembled context → result capsule

Implement [context-isolation-contract.md](./context-isolation-contract.md) and the LLM decision/handoff policy in [invocation-plan.md](./invocation-plan.md) before treating scheduling as the core abstraction.

The parent passes a bounded `SubagentTaskCapsule`, never conversation messages or copied tool output. A shared context builder independently resolves applicable global/root instructions and task-scoped `AGENTS.md`/`CLAUDE.md` files using the same precedence, signature refresh, and lazy nested-discovery helpers as the main agent. It builds a mode-specific minimal prompt/toolset under a worker input budget.

The worker's model/tool transcript remains private. On completion, split output into:

- a compact `SubagentResultCapsule` placed in the parent model's tool result;
- execution metadata (tool-call summaries, usage, retries, timings) emitted through accounting/UI/debug events only.

This permits one subagent for a context-heavy independent investigation. `/fleet` remains responsible for planning and coordinating multiple tasks. Update the normal tool description and main system prompt accordingly, while retaining guidance against delegating trivial or conversation-coupled work.

### 3.1 `WorkerRuntime`

Replace the runner's model-only dependency with a typed runtime:

```ts
interface WorkerRuntime {
  model: LanguageModel;
  selector: string;              // explicit provider:model identity
  providerName: string;
  requestOptions: ProviderRequestOptions;
  capabilities: ProviderCapabilities;
}
```

The runtime should be resolved once per fleet/turn through the existing provider configuration path. It must carry the same provider request options used by the main agent. A configured worker selector is optional; absence means “same explicitly active model,” not “first available model.”

### 3.2 `SubagentExecutionProfile`

Use a small validated profile rather than scattered constants:

```ts
type WorkerMode = 'inspect' | 'semantic-review' | 'research' | 'implement' | 'validate';

interface SubagentExecutionProfile {
  mode: WorkerMode;
  maxConcurrency: number;
  maxSteps: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  summaryChars: number;
  deadlineMs: number;
  retryLimit: number;
  workerModelSelector?: string;
}
```

Profiles are persisted settings patches that preserve unknown fields. Presets are suggestions generated from explicit endpoint/provider facts and user choice. Do not auto-classify an arbitrary remote proxy as cheap or a loopback URL as capable of parallel inference.

Suggested initial presets:

| Profile | Concurrency | Mode | Intent |
|---|---:|---|---|
| `local-safe` | 1 | inspect | Smallest prompt/tool load; no retry storm |
| `local-throughput` | 2 | inspect | User opts into parallel local inference |
| `cloud-balanced` | 3 | inspect | Moderate rate/cost burst |
| `cloud-fast` | 5 | inspect | User explicitly prioritizes latency |
| `implementation-safe` | 1 mutation worker | implement | Serialize shared-tree writes |

These numbers should be configurable and validated, not buried in prompt text.

### 3.3 `SubagentCoordinator`

Create a core, UI-agnostic coordinator with:

- bounded queue/semaphore;
- fleet and worker abort/deadline composition;
- worker IDs and stable task IDs;
- execution profile application;
- optional dependency edges;
- event sink (`queued`, `started`, `retrying`, `completed`);
- aggregate usage/duration metrics;
- shared workspace access policy;
- isolated failure handling.

The normal `subagent` tool can submit one task to the coordinator associated with the parent turn. `/fleet` can submit a validated set. This makes the same hard limits apply to both paths.

Do not place React/Ink in core. The CLI subscribes to coordinator events.

### 3.4 Structured fleet protocol

Use a narrow model-produced plan:

```ts
interface FleetPlan {
  parallelizable: boolean;
  reason: string;
  mode: WorkerMode;
  tasks: Array<{
    id: string;
    title: string;
    instruction: string;
    dependsOn: string[];
    expectedOutput: string;
    allowedCapabilities: string[];
    declaredWrites?: string[];
  }>;
}
```

Flow:

1. `/fleet` passes ephemeral command guidance and the original prompt to a planning step.
2. Validate plan size, IDs, dependency graph, capability names, write conflicts, and profile limits.
3. Coordinator schedules ready tasks with hard concurrency.
4. Optionally run an integration/validation task after mutation workers.
5. Aggregate `SubagentResultV2[]` into the final answer.
6. Persist the original user command, compact plan, and final answer—not the fleet control prompt.

Start with the active main model for planning/aggregation. Worker model selection is explicit and may differ.

### 3.5 Result contract

Replace ambiguous status inference with a richer internal contract:

```ts
type WorkerTermination =
  | 'completed'
  | 'no_output'
  | 'step_limit'
  | 'tool_limit'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'provider_error'
  | 'policy_blocked';

interface SubagentResultV2 {
  capsule: {
    id: string;
    termination: WorkerTermination;
    usable: boolean;
    deliverable: string;
    summaryTruncated: boolean;
    resultHandle?: string;
    coverage?: {reviewed: string[]; omitted: string[]};
    changedPaths: string[];
    validation: Array<{command: string; ok: boolean}>;
  };
  telemetry: {
    usage: TokenUsage;
    durationMs: number;
    attempts: number;
    toolCalls: Array<{name: string; summary: string; durationMs: number}>;
  };
}
```

Only `capsule` enters the parent model's tool-result content. `telemetry` is delivered to UI/accounting/debug consumers out of band. Keep a compatibility adapter to the current `ok/error/timeout/cancelled` shape during migration. UI status must derive from `termination` and `usable`, not parse summary prose.

### 3.6 Workspace access policy

Implement modes incrementally:

1. **Read-only first:** inspect/semantic-review/research omit mutation tools. Bash is either omitted or restricted to commands classified as non-mutating.
2. **Shared-tree implementation:** coordinator requires declared writes, uses a shared canonical-path lock, and permits only one mutation-capable worker by default. A workspace-wide lock covers untrusted/potentially mutating bash.
3. **Integration stage:** after workers complete, parent rereads changed files and runs validation against the final tree.
4. **Future option:** isolated git worktrees or patch-return workers. Do not add this until cleanup, ignored state, and conflict behavior are specified and tested.

Declared writes are planning hints, not a security boundary. Actual mutating tools must acquire coordinator locks using canonical workspace paths.

### 3.7 Context and tool diet

For each task:

- include global/root instructions once;
- initialize `loadedContextFilePaths` and signatures from injected context;
- include subtree instructions when the task's declared scope makes them known;
- enforce a worker input estimate before calling the model;
- expose only profile tools;
- prefer concise subagent instructions over repeating fleet guidance;
- attach a compact task contract: objective, scope, output shape, budget, and completion rule.

If estimated worker input exceeds its profile budget, compact/select context or return a clear `policy_blocked` result. Do not wait for provider overflow.

### 3.8 Cloud/local behavior

#### Cloud

- Preserve cache/sticky-session provider options in worker calls.
- Respect configured concurrency and retry with abort-aware backoff for explicitly retryable errors.
- Surface token totals and model selector; cost estimation should be added only when trustworthy pricing data exists.
- Allow a user-selected economical worker model.

#### Local

- Default suggested concurrency to one unless the user selects otherwise.
- Keep retries at zero or one.
- Use reduced output/context/tool budgets.
- Detect malformed/unsupported parallel tool calls and provide an actionable sequential fallback.
- Never assume a loopback endpoint has a particular context window or parallel capacity; allow user-supplied capability overrides or later capability probing.

## 4. User-facing design

### 4.1 Commands

Proposed compatible syntax:

```text
/fleet <prompt>                         # configured default profile
/fleet --review <prompt>                # read-only inspect profile
/fleet --auto <prompt>                  # allow dependency-aware phases
/fleet --profile local-safe <prompt>
/fleet --workers local:qwen3-coder <prompt>
/fleet --concurrency 2 <prompt>         # per-run explicit override
```

The exact parser can be narrower initially. Unknown flags must produce usage, not enter the model prompt.

### 4.2 Settings

Add a namespaced section, for example:

```json
{
  "subagents": {
    "defaultProfile": "cloud-balanced",
    "profiles": {
      "cloud-balanced": {
        "maxConcurrency": 3,
        "deadlineMs": 180000,
        "maxSteps": 18
      }
    },
    "workerModel": "openrouter:some-explicit-model"
  }
}
```

Settings parsing must fail loudly when malformed and patching must preserve unrelated/unknown fields, per repository contract.

### 4.3 Terminal feedback

Show concise scheduler-owned state:

```text
fleet 7 tasks · profile local-safe · workers local:qwen3-coder · concurrency 1
[2/7] running  Review session persistence       42s
[1/7] done     Review provider security          18s · 8 calls
[0/7] queued   Review MCP boundaries
```

Final metadata should include wall time, summed worker time, peak concurrency, token totals, and counts by termination reason. Keep worker internals non-streaming.

## 5. Key design decisions requiring owner approval

1. **Default mutation policy:** recommended `/fleet` default is read-only unless the prompt explicitly requests edits; mutation concurrency defaults to one.
2. **Default profile selection:** recommended setup asks the user or derives a suggested profile from a chosen provider preset, but stores the explicit result.
3. **Worker-model persistence:** recommended global setting plus per-run override.
4. **Dependent-task behavior:** keep current parallel-only default; add `--auto` rather than silently changing semantics.
5. **MCP access:** recommended explicit read-only allowlist per server/tool; no blanket inheritance.
6. **Result handles:** decide whether full worker artifacts use the existing in-memory tool-output store or a new fleet-scoped artifact with session persistence rules.

## 6. Rollout phases

### Phase A — lightweight context-isolation contract

Add bounded task/result capsules, independently assemble only applicable project instructions with shared `AGENTS.md` logic, build mode-specific minimal prompts/toolsets, keep telemetry out of parent model context, and permit one worker for context-heavy independent work.

**Value:** realizes the primary spin-off-agent benefit before adding fleet complexity.

### Phase B — correctness and truthful outcomes

Centralize budgets, align schema/runtime, fix low-limit synthesis, add termination reasons/no-output/truncation metadata, initialize context state correctly, and pass provider request options.

**Value:** immediate reliability without changing `/fleet` architecture.

### Phase C — coordinator controls

Add hard concurrency, queue, deadlines, events, and aggregate metrics. Route existing tool calls through it.

**Value:** protects cloud spend/rate limits and local resources.

### Phase D — ephemeral fleet control and profiles

Stop persisting `FLEET_GUIDANCE`; add profile settings, explicit worker model, and read-only modes.

**Value:** lower repeated context cost and meaningful cloud/local tuning.

### Phase E — deterministic fleet planning

Add structured plan generation/validation, dependency scheduling, and structured aggregation.

**Value:** reliable behavior across model capability levels and testable `/fleet` contracts.

### Phase F — coordinated implementation

Add write-set locks, bash policy, integration validation, and optionally patch-return/isolation experiments.

**Value:** makes mutation-heavy fleets trustworthy rather than merely fast.

## 7. Success metrics

Collect opt-in/local metrics in debug logs first; do not add telemetry without a separate privacy decision.

- plan parse success by provider/model;
- planned vs actually started/completed tasks;
- peak concurrency and queue time;
- worker termination reason distribution;
- usable-output rate;
- aggregate worker input/output tokens;
- fleet wall time and summed worker time;
- user abort latency;
- write-conflict/policy-block counts;
- validation pass rate after mutation fleets;
- durable context tokens added by one fleet invocation.

Suggested release gates:

- hard concurrency is never exceeded in stress tests;
- every queued/running task reaches a terminal state after completion/abort;
- abort cancels queued and active workers promptly;
- fleet control text is absent from persisted conversation/session;
- `local-safe` never runs more than one worker request concurrently;
- no-output and truncated results are visible and cannot be reported as clean success;
- concurrent same-path file mutations cannot execute;
- provider-specific request settings reach worker requests;
- existing normal-turn and headless behavior remains compatible.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Coordinator adds core complexity | Keep it UI/provider agnostic; pure queue/state helpers plus injected runner/event sink |
| Structured planning adds a model round trip | Permit one-pass normal `subagent`; reserve structured planning for `/fleet`; measure latency/value |
| Small models fail plan schema | Minimal schema, one repair attempt, explicit sequential/stop fallback |
| Worker model setting becomes hidden fallback | Require configured selector; display it at fleet start and in final metadata |
| Locks create false safety confidence | Document shared-tree limitations; serialize mutation by default; final integration validation |
| Read-only bash classification is imperfect | Omit bash in strict review mode initially or use a conservative allowlist |
| More statuses break consumers | Add compatibility adapter and migrate formatters/events/tests before removing V1 |
| Large results bloat parent context | Structured compact summary + truncation metadata + bounded handle |

## 9. Validation strategy

- Unit-test coordinator state transitions with fake clocks and deferred promises.
- Test provider options by capturing `generateText` configuration.
- Test settings migrations/patch preservation.
- Test worker budgets at every boundary.
- Test persisted message/session content for absence of fleet controls.
- Test canonical path locks and bash policy.
- Test local profile with a fake model that rejects parallel calls, emits malformed tool calls, stalls, and returns no usage.
- Test cloud profile with simulated 429/5xx and retry-after behavior.
- Keep live smoke tests optional and provider-gated; never require paid credentials in CI.
