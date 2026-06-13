# Token Efficiency Implementation Plan

Research date: 2026-06-13

Implementation status: deterministic work through Phase 3 is implemented. Provider-backed exit gates and Phase 4 experiments remain pending; see [implementation-status.md](implementation-status.md).

## Principles

1. Measure task success and tokens together.
2. Remove exact duplication before introducing lossy compression.
3. Preserve exact user intent, constraints, decisions, file paths, and validation evidence.
4. Keep provider-cache prefixes stable unless measured savings exceed cache loss.
5. Make detailed output retrievable instead of permanently resident.
6. Continue long work through compact slices with durable state, not an ever-growing transcript.
7. Roll out behavior changes behind flags until live-model evaluations pass.

## Phase 0: Baseline and instrumentation

Implement measurement before changing behavior.

### 0.1 Add a context accounting module

Create `src/core/agent/contextBudget.ts` with pure functions that classify the request payload into:

- base system instructions;
- project context by file;
- tool descriptions and JSON schemas by tool;
- user and assistant text;
- tool-call inputs by tool;
- tool-result outputs by tool;
- synthetic Haze control messages;
- compacted state and summaries.

Use exact JSON-schema serialization through the AI SDK/Zod path where practical. Keep the existing four-character approximation as a provider-neutral fallback, but label it estimated.

Suggested types:

```ts
interface ContextBreakdown {
  logicalInputEstimate: number;
  system: number;
  projectContext: Array<{path: string; tokens: number}>;
  toolSchemas: Array<{name: string; tokens: number}>;
  messagesByRole: Record<string, number>;
  toolInputs: Record<string, number>;
  toolResults: Record<string, number>;
  syntheticControl: number;
}
```

### 0.2 Extend usage telemetry

Update `TokenUsage`, debug UI, and LLM logs to record:

- provider input and output tokens;
- cache-read, cache-write, and no-cache input tokens;
- logical input estimate;
- effective non-cached input;
- per-step context breakdown;
- tool-call count and model-call count;
- compaction and pruning events;
- final task status.

Do not log new prompt content beyond what debug logging already stores. Metrics should contain sizes and hashes by default.

### 0.3 Add an offline trace fixture format

Create `tests/fixtures/agent-traces/` with synthetic, secret-free message histories. Add helpers that calculate how each proposed policy transforms a trace without calling a model.

### 0.4 Baseline report

Add a script such as `scripts/context-report.ts` that prints component sizes for a supplied fixture or current tracked context files. It must not inspect `~/.haze` unless given an explicit path.

### Phase 0 exit gate

- Existing tests pass.
- Accounting totals are stable in snapshot tests.
- Provider-reported cache fields remain visible.
- A baseline scorecard exists for every scenario in `evaluation-plan.md`.

## Phase 1: Deterministic payload reductions

These changes remove duplication or data that cannot be used.

### 1.1 Return file content once

Update `readFile` in `src/llm/hazeTools.ts`:

- return one `content` field containing numbered lines;
- remove the duplicate unnumbered `text` field;
- default to a bounded page, initially 300 lines;
- return `nextOffset`, `totalLines`, and `truncated` when more remains;
- apply the character cap to the actual returned numbered content;
- preserve exact line numbers for `editFile` and `replaceLines` recovery.

Compatibility option: keep the old field names for one minor release only if consumers outside the model use them. Repository tests indicate the tool contract can be migrated directly.

Tests:

- full small file;
- default pagination for a large file;
- explicit offset/limit;
- long lines that hit the character cap;
- CRLF line numbering;
- edit recovery using returned numbered content.

### 1.2 Enforce a true total grep limit

`rg --max-count` applies per file. After parsing, cap the returned match/context records globally and provide `truncated`, omitted count when known, and a narrower-query suggestion. Change the default `contextLines` from 2 to 0 or 1 after live evals show no search-quality loss.

### 1.3 Make bash output adaptive

Change the bash result contract to prioritize parsed information:

- successful validation: return command, exit status, duration, and compact validation summary; omit routine full stdout unless short;
- failed validation: return parsed diagnostics plus bounded relevant stdout/stderr tails;
- general command: return bounded head/tail, omitted-character count, and an output handle;
- retain full output outside active model context for explicit follow-up retrieval.

Implement a session-scoped `ToolOutputStore` under `core/agent/` or `core/session/`. A handle should support paginated reads without adding the full output to the conversation. Avoid writing secrets into tracked workspace files.

Prefer extending `bash` with an `outputCursor` retrieval mode or one generic `readToolOutput` tool. Compare schema cost and model reliability in evals before choosing.

### 1.4 Omit tools from text-only calls

In `streamAssistantResponse`, when `allowTools` is false:

- pass no `tools` property;
- omit `toolChoice` rather than passing `none` with schemas;
- calculate schema tokens as zero;
- send a compact final-state packet instead of the full tool trace where possible.

This change must have a direct unit test around request construction. Refactor stream request assembly into a pure helper so it can be inspected without a live provider.

### 1.5 Remove subagent prompt duplication

Replace `SUBAGENT_SYSTEM_PROMPT + buildSystemPrompt(contextFiles)` with `buildSubagentPrompt()`:

- concise role and completion contract;
- scoped task;
- only relevant tool guidance;
- current date and workspace;
- project context passed once;
- no parent final-template, intent-mode, task-list, completion-loop, or subagent-selection instructions.

Start with all project instruction files to avoid a behavior regression. Relevant-context filtering can follow in Phase 3.

### 1.6 Reduce task-update traffic

Change system guidance from per-task-transition updates to meaningful phase updates:

- create tasks for substantial work, initially five or more concrete steps;
- update when starting a new phase, changing scope, encountering a blocker, or completing the goal;
- return task counts and changed items, not the full list, from `writeTasks`;
- let the UI read the persisted complete list.

### 1.7 Make final responses concise by contract

Replace the mandatory multi-section final template with:

- one short status sentence when status is not obvious;
- changed files and validation evidence in at most three bullets;
- no recap of tool calls or plan unless requested;
- provider-specific low-verbosity controls only when the provider/model supports them.

Keep blocked/partial honesty requirements. The UI already displays tool activity and goal status, so the model should not narrate those again.

### Phase 1 exit gate

- All existing tests plus new contract tests pass.
- Small-edit and validation task success is no worse than baseline.
- Typical file-read result tokens fall at least 45%.
- Text-only follow-ups send zero schema tokens.
- Subagent initial static input falls at least 35% on the repository fixture.
- Median final output falls at least 20% with no evidence omissions.

## Phase 2: Structured working state and context lifecycle

This phase changes how Haze survives long loops.

### 2.1 Introduce `WorkState`

Add `src/core/agent/workState.ts` as the canonical compact state for the active user goal.

```ts
interface WorkState {
  goal: string;
  intent: RequestIntent;
  successCriteria: string[];
  constraints: string[];
  decisions: Array<{decision: string; reason?: string}>;
  files: Array<{path: string; action: 'read' | 'created' | 'modified'; note?: string}>;
  validations: Array<{command: string; status: 'passed' | 'failed'; summary: string}>;
  blockers: string[];
  pending: string[];
  nextAction?: string;
  phase: string;
  revision: number;
}
```

Populate exact fields deterministically from tool events wherever possible. Let the model propose decisions, pending items, and next action through a compact checkpoint only at slice boundaries.

`SessionGoal` should either become this type or delegate to it. Avoid two conflicting state stores.

### 2.2 Separate user conversation from runtime control

Create an internal synthetic-message marker and request assembler. Duplicate-tool warnings, edit-recovery requirements, action nudges, and tool-budget prompts should be ephemeral control messages:

- include at most one current control block in a model request;
- replace the prior block instead of appending another;
- do not persist it as a durable user message;
- log the control reason as metadata.

### 2.3 Prune completed tool traffic

Add a pure `compactToolHistory(messages, policy)` transformation used by `prepareStep` and continuation assembly.

Initial safe policy:

- keep all tool traffic from the latest three tool uses;
- keep failed tool calls until recovered or explicitly recorded as a blocker;
- keep the latest read for every file that is about to be edited;
- keep validation failures until fixed or reported;
- replace older successful reads/searches/listings with one compact evidence record;
- replace older successful mutations with path and change summary in `WorkState`;
- replace old bash output with command, exit status, and validation summary;
- never leave an unmatched tool call or result in provider protocol history.

Use token thresholds in addition to counts. A single large tool result should trigger pruning immediately.

### 2.4 Add work slices

Replace the 30 full-context completion continuations with progress-aware slices:

1. Run a bounded tool slice.
2. If complete, produce a concise final response.
3. If incomplete and progress occurred, checkpoint `WorkState`.
4. Start the next slice with stable policy, `WorkState`, recent evidence, and the original request.
5. If no progress occurred for two slices, finish blocked/partial with evidence.

Recommended initial limits:

- 12 tool calls per slice;
- 3 recent tool uses retained raw;
- configurable total turn budget based on time, calls, and tokens rather than a hard 30-continuation count;
- automatic compaction before a new slice when logical input exceeds the configured budget.

Long autonomy remains possible because slices can continue while progress is recorded. The context stops growing linearly with every action.

### 2.5 Replace message-count compaction with token-aware compaction

Update `compactModelMessages` to accept a token budget and preserve:

- original active request;
- exact `WorkState`;
- explicit user constraints and decisions;
- latest relevant file reads;
- unresolved failures and blockers;
- recent raw messages;
- optional user compaction instructions.

Apply a tiered policy:

1. Clear duplicate and stale tool results.
2. Collapse completed phases into structured state.
3. Use a model-generated semantic summary only when still above budget.

For model-generated summaries, request a typed object and merge it into exact deterministic fields. Do not repeatedly rewrite the entire prior summary; incrementally add or update fields to reduce context collapse.

### 2.6 Persist canonical compact state

Add a versioned session entry such as `work_state_snapshot`. On resume, restore the latest state plus the recent conversation window instead of relying only on the largest `conversation_snapshot`.

Maintain backward compatibility with existing JSONL sessions.

### Phase 2 exit gate

- The 60-step workflow completes without overflow.
- Required-fact recall after two compactions is at least 95%.
- No provider errors from unmatched tool protocol messages.
- Long-horizon task success remains within 5 percentage points of baseline.
- Non-cached input falls at least 40% on the 20-step benchmark.
- Repeated compaction does not lose explicit user constraints in any deterministic fixture.

## Phase 3: Cache-aware tools, skills, and context

### 3.1 Build a provider capability layer

Extend model resolution to expose capabilities rather than checking model-name strings throughout streaming code:

```ts
interface ProviderCapabilities {
  reportsCacheUsage: boolean;
  supportsPromptCacheKey: boolean;
  supportsExtendedCacheRetention: boolean;
  supportsStickySessionId: boolean;
  supportsServerCompaction: boolean;
  supportsTextVerbosity: boolean;
}
```

Use supported options only:

- stable `promptCacheKey` for direct OpenAI where available;
- OpenRouter `session_id` or header for sticky routing;
- explicit cache controls only through providers that support them;
- server compaction only as an optional adapter, with Haze's portable `WorkState` retained.

### 3.2 Make the stable prefix explicit

Assemble requests in this order:

1. stable tool schemas;
2. stable concise Haze policy;
3. stable project context for the session;
4. compact working state;
5. recent messages and current request;
6. volatile control message.

Avoid timestamps, counters, random IDs, or changing tool order in the stable prefix. Current date can remain if computed once per session.

### 3.3 Consolidate skill tools

Replace one tool per installed skill with a single `skill` tool:

- compact catalog of `name: description` entries;
- `name` input to load one skill;
- optional `section` or reference path for progressive disclosure;
- return the skill body first and references only on demand when large.

If direct per-skill tools outperform the catalog on selection accuracy, keep a hybrid: expose only the top few relevant skill tools plus one catalog tool. Selection must be evaluated, not assumed.

### 3.4 Evaluate tool profiles

Compare these variants:

- all core tools always present;
- stable read-only and read-write profiles chosen once per user turn;
- dynamic tools per step;
- one dispatcher for rarely used tools.

Measure logical schema savings, cache hit ratio, wrong-tool calls, and task success. Prefer a stable per-turn profile over per-step changes if savings are similar, because exact tool prefixes improve caching.

### 3.5 Budget project context

Add diagnostics first:

- total project-context tokens;
- per-file tokens;
- duplicate-content hashes;
- warning when project context exceeds a configurable share of the window.

Then evaluate an opt-in context manifest:

- always inline nearest-scope critical instructions;
- retain global safety and workflow directives;
- represent large architecture/reference sections by path and heading;
- load details just in time through `readFile`.

Do not enable generated context summaries by default until instruction-following evals pass across nested `AGENTS.md` and `CLAUDE.md` fixtures.

### Phase 3 exit gate

- Supported providers show improved cache hit rate after the first step.
- Cache-aware changes reduce effective billed input without increasing logical input.
- Skill selection accuracy remains within 2 percentage points of baseline.
- Tool-profile changes do not increase unavailable-tool continuations.
- Project-context optimization has zero critical-instruction misses in the held-out set.

## Phase 4: Optional advanced compression

Only start this phase after deterministic context management is stable.

Experiments may include:

- provider-native server compaction;
- a small-model semantic compactor;
- LongLLMLingua-style prompt compression for prose-only historical context;
- retrieval over old session artifacts;
- model-specific reasoning/thinking retention policies.

Never compress:

- source code that will be edited from the compressed representation;
- exact commands, paths, identifiers, error messages, or user constraints;
- active tool protocol messages;
- secrets or untrusted content through an external compression provider without explicit policy.

## File-level change map

| File or module | Planned responsibility |
| --- | --- |
| `src/core/agent/contextBudget.ts` | Context classification, estimates, thresholds |
| `src/core/agent/workState.ts` | Canonical structured long-horizon state |
| `src/core/agent/compaction.ts` | Tiered token-aware compaction |
| `src/core/agent/toolOutputStore.ts` | External full-output storage and pagination |
| `src/cli/commands/streaming.ts` | Request assembly, slices, ephemeral controls, pruning |
| `src/llm/systemPrompt.ts` | Concise stable parent prompt |
| `src/core/subagent/subagentRunner.ts` | Dedicated subagent prompt and handoff |
| `src/llm/hazeTools.ts` | Bounded result contracts and output handles |
| `src/skills/skillTools.ts` | Single catalog/load tool or evaluated hybrid |
| `src/config/contextFiles.ts` | Context diagnostics, deduplication, optional manifest |
| `src/core/session/sessionStore.ts` | Versioned work-state snapshots |
| `src/llm/client.ts` | Provider capabilities and cache options |
| `src/core/log/llmLog.ts` | Size-only context and cache telemetry |
| `src/cli/commands/chat.tsx` | Debug token display and compaction status |

## Rollout controls

Use environment flags or settings during development:

- `HAZE_CONTEXT_POLICY=legacy|bounded|work-state`
- `HAZE_TOOL_OUTPUT_POLICY=legacy|compact`
- `HAZE_SKILL_TOOL_MODE=per-skill|catalog`
- `HAZE_CACHE_MODE=off|auto`

Remove flags only after the corresponding phase passes the evaluation gates across at least one strong model, one fast model, and the default OpenRouter path.

## Documentation changes after implementation

Update:

- `README.md` for automatic context management and debug metrics;
- `AGENTS.md` for new tool-result and session-state contracts;
- `CHANGELOG.md` for behavior and compatibility changes;
- example skills if skill loading changes;
- release notes with measured benchmark deltas, not projected savings.
