# Product contract: lightweight spin-off subagents

**Date:** 2026-07-31
**Purpose:** define the primary value of a subagent independently of parallel `/fleet` orchestration.

## 1. Product goal

A subagent is a **temporary spin-off agent with a fresh, purpose-built context**. Its value is not merely parallel execution. Its primary value is preventing exploratory work from filling the main thread with searches, file contents, command output, intermediate reasoning, and discarded approaches.

The desired lifecycle is:

```text
main thread
  └─ creates a small task capsule
       └─ fresh subagent context
            ├─ minimal worker system prompt
            ├─ same project-instruction discovery rules as the main agent
            ├─ only task-relevant tools and context
            ├─ private intermediate work
            └─ compact result capsule
                 └─ main thread receives only the deliverable
```

The subagent is disposable. After its result is returned, its model messages and intermediate tool results are discarded unless debug logging is explicitly enabled. The main conversation must not inherit the worker transcript.

## 2. Current alignment and remaining gap

The current runner already provides an important part of this contract: each worker request contains only one user task and no main-thread or sibling conversation history (`runSubagent` creates a fresh `messages` array). Intermediate generation is non-streaming and does not become assistant prose in the main transcript.

It does not yet fully optimize for the spin-off goal:

- the parent supplies an unconstrained free-form task instead of a validated task capsule;
- every worker receives the parent-provided `contextFiles` array as one undifferentiated bundle rather than assembling and budgeting project instructions for the task scope;
- worker context is passed through from the parent instead of independently resolved through the same context-loading policy;
- the default worker receives the complete built-in worker tool allowlist;
- worker results include tool-call log metadata in the model-facing tool result, although the parent usually needs only the deliverable and outcome;
- there is no measured worker input budget or guarantee that the returned capsule is smaller than the private work it replaces.

## 3. Non-negotiable isolation rules

### C1. No main conversation inheritance

A worker must not receive:

- prior user or assistant messages from the main thread;
- main-thread tool calls/results;
- sibling worker messages/results;
- hidden main-turn recovery controls;
- the full `/fleet` orchestration prompt;
- main-thread narration or scratch planning.

The only bridge into a worker is an explicit task capsule plus project instructions resolved under C3.

### C2. Explicit task capsule

The parent creates a compact, self-contained handoff:

```ts
interface SubagentTaskCapsule {
  id: string;
  objective: string;
  deliverable: string;
  scopeHints?: string[];
  acceptanceCriteria?: string[];
  mode: 'inspect' | 'research' | 'implement' | 'validate';
  allowedCapabilities: string[];
  contextHints?: Array<{
    path: string;
    reason: string;
  }>;
}
```

Rules:

- `objective` describes the outcome, not the parent's work process.
- `deliverable` states exactly what must come back.
- `scopeHints` point to likely areas but do not embed file contents.
- `acceptanceCriteria` include only constraints needed to judge this task.
- `contextHints` are references, not copied tool output.
- The capsule has strict size limits. If it cannot be made self-contained within the limit, the task is probably too coupled to the main thread and should stay in the main agent.

Do not solve under-specification by pasting the whole conversation into `objective`.

### C3. Same `AGENTS.md` logic, independently resolved

“Fresh context” must not mean “missing project rules.” A worker follows the same instruction precedence and lazy-discovery contract as the main thread:

1. load applicable global instructions;
2. load workspace ancestor/root `CLAUDE.md`/`AGENTS.md` using the existing precedence rules;
3. if task scope hints identify a subtree, load applicable instructions for that scope;
4. lazily discover more-specific nested instructions when worker tools touch deeper paths;
5. reread instructions when signatures change;
6. pause a mutation when newly discovered instructions must be reviewed.

The worker should call the shared context loader with its workspace/session and task scope. It should not blindly clone the parent's accumulated `contextFiles`, because the parent may have loaded unrelated subtree instructions earlier in the conversation.

Use one shared policy implementation for main and worker contexts. Do not duplicate precedence logic in a subagent prompt.

### C4. Minimal optimized worker prompt

The worker system prompt should contain only:

- identity and task-boundary rule;
- concise tool-use and completion rules relevant to its mode;
- applicable project instructions from C3;
- current date and workspace;
- a short private-context reminder: investigate freely, return only the deliverable.

It should not contain:

- the main agent's complete operating manual when a shorter worker equivalent suffices;
- `/fleet` decomposition/wave guidance;
- tools that are unavailable to the worker;
- generic cloud/local prose;
- repeated instructions already encoded by tool schemas;
- main conversation summaries.

Prefer mode-specific prompts and tool schemas. An inspect worker should not pay prompt/schema cost for editing tools.

### C5. Private intermediate context

Reads, searches, fetched pages, command output, tool retries, and intermediate model text stay inside the worker request. They may be bounded and compacted within that request, but they are never appended to the main `ModelMessage[]`.

Debug logs may record bounded worker details only when `--debug` is active, following existing secret and persistence rules.

### C6. Result capsule only

The model-facing worker result should be the smallest object the parent needs to continue:

```ts
interface SubagentResultCapsule {
  id: string;
  termination: WorkerTermination;
  usable: boolean;
  deliverable: string;
  changedPaths?: string[];
  validation?: Array<{command: string; ok: boolean}>;
  coverageGaps?: string[];
  truncated: boolean;
  resultHandle?: string;
}
```

Do not put per-tool call logs, raw token usage, internal retries, or verbose timing records into the parent model's tool-result content. Send those through UI/debug/accounting events out of band. The terminal can remain observable without spending main-thread model context.

If a detailed artifact is too large, return a compact synthesis plus a bounded handle. The parent should retrieve it only when needed.

### C7. One-way handoff by default

A worker completes one task and returns once. It does not remain as a conversational persona, receive follow-up chat history, or ask the user routine questions. If blocked by missing essential information, it returns a concise blocked result so the main agent can decide whether to ask the user or launch a new worker.

A follow-up worker is a new spin-off with a new capsule. Persistent worker threads are a separate feature and are out of scope.

### C8. Context isolation is useful without parallelism

The normal main agent should be allowed to use one subagent when context isolation has clear value, even if there is not a second parallel task. Examples:

- inspect a large log or generated file and return only the diagnosis;
- research an external API while keeping fetched documentation out of the main thread;
- perform a broad repository survey and return a compact map;
- run a noisy validation/debugging investigation and return the root cause;
- compare alternatives in a disposable context.

This changes the current tool description, which restricts use to requests with two or more independent tasks. `/fleet` remains the feature for multiple scheduled tasks; `subagent` is the context-isolation primitive beneath it.

Do not delegate tiny work where the task/result capsule costs more context than doing the work directly.

## 4. Context assembly design

Create a shared context builder rather than passing `contextFiles` directly:

```ts
interface WorkerContextRequest {
  cwd: string;
  scopeHints: string[];
  mode: WorkerMode;
  inputBudgetTokens: number;
}

interface WorkerContextBundle {
  instructions: ContextFile[];
  loadedPaths: Set<string>;
  loadedSignatures: Map<string, string>;
  systemPrompt: string;
  tools: ToolSet;
  estimatedTokens: number;
}
```

Recommended algorithm:

1. Resolve global and ancestor/root instruction files using existing config helpers.
2. Resolve scope-specific instructions only for validated workspace paths in `scopeHints`.
3. Build the mode-specific toolset.
4. Build the concise worker prompt.
5. Estimate instruction + task + tool-schema input.
6. If over budget, remove optional context/tool capabilities; never remove applicable project instructions.
7. If still over budget, reject/split the task instead of silently truncating project rules.
8. Initialize lazy-discovery state from the exact instruction files included.

Project instructions are mandatory policy context; arbitrary parent context is optional task context.

## 5. Parent behavior

Before delegation, the parent should decide:

1. Will private exploration likely produce substantially more context than the result capsule?
2. Can the task be stated independently without copying conversation history?
3. Is the required project scope known or discoverable by the worker?
4. Does the task require user interaction or a dependent result still being produced in the main thread?
5. Is delegation worth the extra model request, latency, and—on cloud models—cost?

Delegate when answers 1–3 are yes and 4 is no. Account for 5 using the selected execution profile.

The parent should not repeat a worker's entire deliverable in prose. It should use or summarize it according to the user's request, preserving evidence and stated coverage gaps.

## 6. Cloud and local optimization

The isolation contract is the same for every provider; budgets differ.

### Cloud workers

- optimize repeated project instructions with provider cache settings where supported;
- use an explicitly selected worker model when configured;
- keep the result capsule small to reduce the parent's next request cost;
- expose usage out of band for cost awareness.

### Local workers

- use smaller mode-specific prompts/tool schemas;
- default to one active generation unless explicitly configured otherwise;
- set a lower worker input/output budget appropriate to user configuration;
- avoid requiring parallel tool-call syntax for a single isolation worker;
- return structured fallback errors when the model cannot call tools reliably.

Do not weaken project instructions for a local model. Reduce unrelated context and capabilities instead.

## 7. Acceptance criteria

A compliant implementation must prove:

1. Captured worker messages contain exactly the task capsule and no main/sibling conversation messages.
2. Captured worker instructions contain applicable global/root/scoped project instructions under the same precedence rules as the main agent.
3. Unrelated nested instructions previously loaded by the main thread are absent.
4. Touching a new subtree lazily discovers its instructions and applies mutation-stop behavior.
5. The worker receives no `/fleet` guidance.
6. An inspect worker receives no mutation tool schemas.
7. The parent model-facing result contains the result capsule but no worker transcript or per-tool log.
8. UI/debug accounting can still display worker duration, tool count, and tokens out of band.
9. Worker input and returned-capsule token estimates are measured.
10. A single noisy independent task may use `subagent`; trivial direct tasks remain in the main agent.
11. Session persistence contains the task/result capsules only, never private worker messages.
12. Aborted, failed, no-output, and truncated workers return truthful compact outcomes.

## 8. Value metrics

The core metric is **main-context tokens avoided**, not number of workers spawned.

For each worker, estimate:

```text
private worker context generated
- task capsule tokens
- result capsule tokens
= estimated main-context tokens avoided
```

Also report internally:

- task capsule size;
- worker initial input size;
- private tool-result/model-message size;
- result capsule size;
- ratio of private context to returned context;
- usable-result rate;
- latency and provider usage.

Do not claim exact savings when only heuristic estimates are available. A worker that returns nearly everything it read has failed the isolation goal even if its task completed.
