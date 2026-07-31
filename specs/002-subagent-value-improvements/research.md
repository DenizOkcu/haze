# Research: current subagent and `/fleet` situation

**Date:** 2026-07-31
**Reviewed version:** `package.json` 0.9.0 on branch `001-fleet-subagents`
**Method:** static review of source, tests, current fleet specification, provider setup, turn runtime, and terminal formatting. No live cloud billing or local-model benchmark was run.

## 1. What exists today

There are two user/model entry paths into the same worker primitive:

1. **Normal turns expose a `subagent` tool.** `assembleRequestContext` always registers it and passes the active main model to `createSubagentTool` (`src/llm/requestContext.ts:53`). The main model decides whether to call it.
2. **`/fleet <prompt>` is a native slash command.** It wraps the user prompt in `FLEET_GUIDANCE` and starts an ordinary model turn (`src/cli/commands/fleetCommand.ts:14`, `:76`). The model still performs decomposition, emits subagent calls, manages waves, and aggregates results.

Each subagent:

- runs a fresh `generateText` loop with only its assigned task as conversation history;
- uses the same model object as the parent;
- can use a fixed built-in allowlist: file discovery/read/search, bash, output handles, edits/writes, and fetch;
- cannot call another subagent, skills, MCP tools, or LSP tools;
- has local step/tool/output bounds;
- returns a compact structured result with status, summary, tool-call metadata, token counts, and duration;
- receives the parent turn's loaded project instruction files in its system prompt;
- propagates the parent abort signal.

The terminal shows each subagent tool call as a separate activity row and records nested token usage. Worker token streams are intentionally not shown.

### Primary product intent: context isolation before parallelism

The most important subagent use case is a temporary spin-off context: give a fresh worker a compact task, let reads/searches/tool output remain private, and return only the end result to the main agent. Parallel `/fleet` execution is one consumer of that primitive, not its definition.

The current implementation is partially aligned because the worker receives no main conversation history. It is not fully optimized for this goal because it passes through the parent's `contextFiles` bundle instead of independently assembling/budgeting task-scoped project context, defaults to a broad toolset, accepts an unconstrained free-form handoff, and returns tool-call metadata inside the parent model-facing result. The intended contract is specified in [context-isolation-contract.md](./context-isolation-contract.md).

A key implication is that a single noisy independent investigation can justify a subagent even when there are not two parallel tasks. The current tool description and system prompt prohibit this by defining subagents only in terms of two-or-more-way parallelism (`src/core/subagent/subagentRunner.ts:168`, `src/llm/systemPrompt.ts:45`).

## 2. Current strengths

### S1. Context isolation is real and useful

`runSubagent` constructs a fresh request containing one user task, so sibling workers do not inherit the main conversation or each other's work. Tests explicitly cover this. This reduces pollution in the main conversation and is especially valuable for independent audits, research axes, and repository surveys.

### S2. Workers are bounded and narration-resistant

The runner caps steps, tool-only loops, total tool calls, output tokens, and returned summary length (`src/core/subagent/subagentRunner.ts:11-26`, `:101-145`). The forced synthesis path preserves accumulated history, fixing the earlier failure where gathered evidence was discarded. The tests cover chatty models, final-step synthesis, cancellation, errors, and partial failure.

### S3. Failures are isolated

Every worker catches its own errors and returns a status instead of throwing into sibling work. A failed worker therefore does not automatically collapse a parallel wave.

### S4. Abort and UI integration are already solid foundations

The parent `AbortSignal` reaches every worker. The main idle timer recognizes in-flight tools, the UI renders separate task previews/statuses, and nested token counts feed usage accounting. These are valuable primitives for a future scheduler.

### S5. The provider surface already supports cloud and local endpoints

The product supports OpenAI-compatible cloud providers and loopback endpoints such as Ollama, llama.cpp, MLX Server, and LM Studio. No new provider SDK is required to begin improving worker policy.

## 3. Findings

Severity here means impact on user value/correctness, not exploit severity.

### F0 — High: the public goal is framed as parallel fan-out instead of disposable context isolation

**Evidence**

- The main system prompt says `subagent` is only for two or more independent tasks (`src/llm/systemPrompt.ts:45`).
- The tool description repeats that restriction and tells the model to spawn all workers in one step (`src/core/subagent/subagentRunner.ts:168`).
- Yet the runner's actual architecture—a fresh message history and result-only generation—is also valuable for one large/noisy investigation.

**Impact**

Users miss the context-saving benefit unless their request happens to decompose into multiple tasks. The parent may perform broad logs/docs/repository exploration directly, filling the main thread with data that should have remained disposable. At the same time, the worker handoff/result boundaries are not optimized enough to guarantee that only essential context crosses between agents.

**Recommendation**

Make context isolation the `subagent` product contract and parallel orchestration the `/fleet` contract. Introduce bounded task and result capsules, independently assemble worker project context using the same `AGENTS.md` precedence/lazy-discovery implementation, and move tool logs/tokens/timing to out-of-band events. Permit one worker when estimated private investigation meaningfully exceeds the expected result capsule.

### F1 — High: `/fleet` concurrency and write safety are promises made to the model, not enforced contracts

**Evidence**

- `FLEET_GUIDANCE` says at most five workers in flight and asks the model to run waves.
- The `subagent` tool itself executes one worker per call and has no shared scheduler or semaphore.
- Each worker creates a private `HazeToolContext` (`src/core/subagent/subagentRunner.ts:91`).
- `inFlightMutationPaths` is therefore private to one worker (`src/llm/tools/toolContext.ts:32`, `:155-228`).

**Impact**

A model can exceed five calls, fail to launch calls in the same step, skip a wave, or concurrently write the same file. This is more likely to matter with small local models that follow long orchestration prompts less reliably, but capable cloud models can also violate soft limits. Cloud users risk burst rate limits/cost; local users risk saturating RAM/VRAM or queueing many generations on one server.

**Recommendation**

Introduce a turn-scoped `SubagentCoordinator` with a hard semaphore, queue, cancellation, worker IDs, and shared mutation scope. Let `/fleet` submit a plan to that coordinator rather than asking the model to implement scheduling through tool-call timing.

### F2 — High: every worker uses the main model; there is no explicit worker model or execution profile

**Evidence**

`assembleRequestContext` passes `input.model` directly into `createSubagentTool` (`src/llm/requestContext.ts:53`). The subagent schema has only `task`, `tools`, and `maxSteps`.

**Cloud impact**

Running five premium-model workers can multiply cost and trigger request/token rate limits. Users cannot select a cheaper/faster worker model while retaining a stronger orchestrator/aggregator.

**Local impact**

Parallel generations contend for the same local server and model allocation. Five-way concurrency may be much slower than one or two workers, may exceed memory, and can reduce prompt-processing throughput. Conversely, users with multiple local endpoints cannot route workers to a dedicated model/server.

**Recommendation**

Add explicit, persisted worker settings: model selector, max concurrency, deadline, default tool profile, and token/step budgets. Never silently select another configured model. Offer presets as user-visible suggestions, not hidden fallback:

- `cloud-balanced`: concurrency 3, bounded retries, cost display;
- `cloud-fast`: concurrency up to 5, explicitly selected economical worker model;
- `local-safe`: concurrency 1, shorter context/output, no retry storm;
- `local-throughput`: user-selected concurrency 2+ after confirming server capacity;
- `custom`.

### F3 — High: worker model calls lose provider-specific request settings

**Evidence**

The main `ToolLoopAgent` applies `providerRequestSettings(runtime.config)` (`src/cli/commands/streaming.ts:123`, `:204-210`). `runSubagent` receives only the model object and calls `generateText` without those settings (`src/core/subagent/subagentRunner.ts:101`).

**Impact**

Subagents do not receive main-turn features such as OpenAI prompt cache keys/text verbosity or OpenRouter sticky session headers. This can reduce cache locality, increase cloud cost/latency, and cause behavior differences between parent and worker requests.

**Recommendation**

Pass a typed worker runtime (`model`, request options, model identity, provider capabilities) rather than only a model object. Derive worker request settings through the same provider path as the main agent.

### F4 — High: no worker-owned wall-clock deadline; “timeout” means step exhaustion

**Evidence**

`runSubagent` accepts only the parent abort signal. It has no deadline timer. Its `timeout` status is assigned when `result.steps.length >= maxSteps` (`src/core/subagent/subagentRunner.ts:144-147`). Meanwhile, the main idle timer deliberately waits while a tool is in flight (`src/cli/commands/streaming.ts:98-105`).

**Impact**

A stalled provider call can keep a fleet waiting without a worker-level cutoff. The status name also conflates a step-budget stop with elapsed-time timeout, making remediation and UI reporting ambiguous. This matters for unreliable cloud endpoints and local servers that stall under memory pressure.

**Recommendation**

Use a composed abort signal with a per-worker deadline and distinguish `deadline_exceeded`, `step_limit`, `cancelled`, `provider_error`, and `ok` internally. Preserve a small stable user-facing status mapping if desired.

### F5 — High: mutation isolation does not cover bash and disjoint files are not sufficient for coherent parallel edits

**Evidence**

`isMutatingTool` recognizes only `editFile`, `replaceLines`, and `writeFile` (`src/llm/tools/toolContext.ts:124`). Bash is treated as deduplicable/read-only for orchestration purposes (`:135-136`) even though a command can alter any workspace path. Fleet guidance only asks for disjoint file writes.

**Impact**

A worker can mutate through bash outside any lock. Even genuinely disjoint edits can be semantically coupled: workers may validate against a transient half-updated tree, update generated/shared metadata indirectly, or make incompatible API/caller changes. A textual path lock alone does not make parallel implementation transactional.

**Recommendation**

- Ship a `review` worker profile with no mutating tools and a read-only bash policy.
- For implementation, coordinate declared write sets and serialize a validation/integration stage after workers finish.
- Treat potentially mutating bash as incompatible with concurrent mutation unless executed in an isolated worktree/sandbox or classified under a conservative workspace-wide lock.
- Longer term, consider workers returning patches for parent-controlled application instead of mutating the shared tree directly.

### F6 — Medium-high: fleet orchestration guidance becomes durable conversation content

**Evidence**

At review time `buildFleetPrompt('x')` is 6,365 characters, approximately 1,592 tokens using the repository's four-characters-per-token heuristic. `handleFleetCommand` passes that string as the turn value. The normal turn runtime appends `value` as a durable user message (`src/cli/commands/streaming.ts:134-144`). `displayValue` changes transcript display only.

**Impact**

Every fleet invocation permanently adds a large operational prompt to active conversation history, weakening the advertised context-saving benefit and repeatedly charging cloud/local prompt processing. On local models with smaller context windows this is especially expensive.

**Recommendation**

Pass command guidance as ephemeral control/instructions that are stripped from durable history. Persist only the original `/fleet` prompt plus the final plan/result. Add a regression test that resumed sessions contain neither `FLEET_GUIDANCE` nor synthetic command controls.

### F7 — Medium-high: prompt-only orchestration is least reliable where local-model support needs the most help

**Evidence**

Decomposition, tool selection, parallel launch, wave management, write-set discipline, failure classification, and aggregation all live in one long user-level directive. There is no structured decomposition schema or scheduler-owned state.

**Impact**

Tool-call-capable local models vary widely in instruction following, parallel tool-call support, context windows, and schema fidelity. A 1.6k-token orchestration preamble consumes scarce attention before project context and tools. Cloud models usually handle this better, but behavior remains nondeterministic and difficult to test end to end.

**Recommendation**

Make `/fleet` a two-stage protocol:

1. model returns a small structured `FleetPlan` (tasks, dependencies, mode, allowed tools, optional declared writes, expected output);
2. code validates and schedules the plan, then a model aggregates structured results.

If structured planning fails, report a clear fallback: retry once with a simpler schema, run sequentially when explicitly allowed, or stop with actionable guidance. Do not silently pretend a fleet ran.

### F8 — Medium: tool access is simultaneously too broad and too narrow

**Evidence**

The default worker gets all nine built-in tools, including mutation and bash (`src/core/subagent/subagentRunner.ts:10`). It cannot receive available read-only LSP tools, selected MCP research tools, or skills.

**Impact**

- Broad defaults increase tool-schema tokens and accidental mutation risk, particularly for smaller models.
- Review workers cannot use semantic navigation.
- Research workers cannot use a configured documentation MCP server.
- Passing all MCP/skill capabilities blindly would introduce security, prompt-size, and recursion risks.

**Recommendation**

Define explicit capability profiles instead of arbitrary passthrough:

- `inspect`: list/read/grep/readToolOutput plus read-only validation commands;
- `semantic-review`: inspect + available LSP tools;
- `research`: inspect + fetch + explicitly approved read-only MCP tools;
- `implement`: inspect + file mutations + controlled bash;
- `validate`: inspect + bash, no edits.

Keep recursion disabled. Never expose credentials or arbitrary tool names through task text. Tool inclusion must be validated against coordinator policy and current availability.

### F9 — Medium: result semantics can mislead parent and user

**Evidence**

- Empty final text becomes the literal summary “Subagent completed without text output.” while status remains `ok` (`src/core/subagent/subagentRunner.ts:140-147`).
- Finishing exactly on `maxSteps` is marked `timeout`, even if that final step contains a complete synthesis.
- Summaries are cut at 4,000 characters with no truncation marker or metadata.
- Provider errors return token counts as zero even if earlier worker steps consumed tokens.

**Impact**

Aggregation can report silent workers as successful, complete workers as timed out, and truncated findings as complete. Cost reports undercount failed workers.

**Recommendation**

Return structured fields such as `terminationReason`, `hasUsableOutput`, `summaryTruncated`, `coverage`, and optional `resultHandle`. Determine success from termination plus usable deliverable, not step count alone. Preserve partial usage from completed steps.

### F10 — Medium: budget API and implementation disagree

**Evidence**

The public tool schema allows `maxSteps` up to 50 and describes a default of 25 (`src/core/subagent/subagentRunner.ts:172`), but runtime clamps it to 25. With `SYNTHESIS_RESERVE = 2`, very low requested limits force synthesis before useful tool work: for `maxSteps <= 2`, `steps.length >= maxSteps - 2` is true before the first step.

Subagent constants also live in `subagentRunner.ts`, despite `src/core/agent/AGENTS.md` identifying `budgets.ts` as the centralized home for main/subagent budgets.

**Impact**

The model and users cannot reason accurately about worker budgets. Local users cannot deliberately choose a larger step budget, while tiny budgets behave unexpectedly.

**Recommendation**

Centralize and export subagent budgets; align schema maximum with runtime; enforce a meaningful minimum; compute synthesis reserve safely; and test boundary values (minimum, default, maximum, maximum+1).

### F11 — Medium: worker context is not tailored to model capacity or task

**Evidence**

Every worker receives all parent-loaded context files and its allowed tool schemas. There is no worker context budget analogous to `ACTIVE_CONTEXT_TOKEN_BUDGET`, no task-specific context selection, and no model context-capability metadata.

The worker `HazeToolContext` does not initialize `loadedContextFilePaths` from context already placed in its system prompt (`src/core/subagent/subagentRunner.ts:91`). Scoped discovery can therefore surface already-known ancestor instructions again and may unnecessarily pause a first mutation.

**Impact**

Cloud users pay repeated prompt cost across workers. Local workers can overflow or spend most prompt capacity on general instructions/tool schemas. Duplicate instruction discovery adds noise and extra steps.

**Recommendation**

Add a worker input budget and “context manifest” containing only applicable root/global instructions plus task-relevant files when known. Initialize loaded path/signature state from those files. Prefer smaller tool profiles and compact worker prompts for constrained models.

### F12 — Medium: observability does not yet answer “was fleet worth it?”

**Evidence**

The UI shows task previews, status summaries, elapsed time, and nested token counts, but there is no fleet run identity, queue/wave state owned by code, model identity per worker, aggregate cost estimate, speedup estimate, coverage, retry count, or reason a profile serialized work.

**Impact**

Cloud users cannot easily judge cost/value. Local users cannot tell whether apparent parallelism is actually server-side serialization or overload. Maintainers lack evidence to tune the default cap.

**Recommendation**

Emit structured fleet events and a final run summary: workers planned/started/completed, peak concurrency, wall time, summed worker time, tokens, model selectors, retries, and termination reasons. Avoid claiming speedup unless a sequential baseline exists; report “parallelism factor” or summed-worker-time/wall-time as an approximation.

### F13 — Low-medium: normal `subagent` and `/fleet` instructions can conflict

The tool description says to “spawn all of them in one step,” while fleet guidance says to cap a wave at five and queue the rest. The distinction is understandable to strong models but is not a machine-enforced contract. Replace both with one coordinator-backed contract and concise tool description.

### F14 — Low-medium: `/fleet` declines dependent work after spending a model turn

This is the documented contract, but it can feel low-value. Add an explicit mode rather than changing behavior silently:

- `/fleet --parallel-only` (current behavior);
- `/fleet --auto` (run parallelizable phases and let the parent handle dependencies sequentially);
- `/fleet --review` (read-only fan-out).

Keep the default conservative until usage evidence supports changing it.

## 4. Best-fit use cases today

### High value now

- one large/noisy independent investigation whose compact result is more useful than its private reads/tool output;
- independent read-only security/correctness review axes;
- separate research questions;
- surveying unrelated packages/modules;
- generating independent drafts or alternatives;
- cloud models with reliable tool calling and acceptable parallel cost;
- local servers explicitly configured to handle concurrent generations.

### Use cautiously now

- multiple workers editing one repository;
- work involving shared APIs, generated metadata, lockfiles, or migrations;
- local models with limited context/tool-call support;
- rate-limited or premium cloud models;
- tasks needing LSP/MCP/skills inside the worker;
- tasks where a missing/truncated finding is unacceptable.

### Avoid now

- sequential refactors where task B depends on task A;
- concurrent writes to the same file;
- workflows whose mutation happens primarily through bash;
- fleets larger than endpoint capacity;
- unattended runs requiring a hard completion deadline.

## 5. Cloud vs local needs matrix

| Need | Cloud models | Local models | Product response |
|---|---|---|---|
| Concurrency | Bound rate/cost bursts | Bound RAM/VRAM and server queues | Hard configurable semaphore |
| Model routing | Strong parent + cheaper workers | Strong parent + small worker or separate endpoint | Explicit worker model selector |
| Prompt size | Cost/cache concern | Context/throughput concern | Ephemeral fleet control + context/tool diet |
| Retry policy | Handle 429/5xx with jitter | Avoid retry storms on overloaded server | Provider/profile-aware retries |
| Deadline | Protect spend and hanging APIs | Recover from stalled generation/OOM | Per-worker and fleet deadlines |
| Tool reliability | Usually strong, still nondeterministic | Highly variable parallel/schema support | Structured plan validation and graceful fallback |
| Mutation | Cross-request consistency risk | Same plus slower stale snapshots | Read-only default mode + coordinator/patch application |
| Observability | Tokens/cost/rate-limit evidence | queue time, throughput, peak concurrency | Structured metrics and run summary |
| Output budget | Cost/latency | generation time/context | Profile-specific output and summary limits |

## 6. Conclusions

1. The worker runner is a sound seed for a disposable context-isolation primitive, not yet a complete lightweight handoff contract or fleet runtime.
2. Context isolation should permit one substantial/noisy independent task; parallelism remains `/fleet`'s concern.
3. Workers should independently resolve only applicable project instructions through the shared `AGENTS.md` logic rather than inherit unrelated parent context.
4. The parent model should receive a compact result capsule only; tool logs, usage, retries, and timings belong in out-of-band events.
5. Prompt improvements have reached diminishing returns; the current fleet prompt is already long and detailed.
6. The best immediate product value is reliable read-only review/research with measurable main-context savings.
7. Safe parallel implementation requires workspace coordination and a final integration/validation phase.
8. Cloud and local users need different defaults, but all model/provider changes must remain explicit—no silent fallback or hidden model selection.
9. A deterministic scheduler and structured results will improve both powerful cloud models and weaker/local tool callers while making behavior testable.
