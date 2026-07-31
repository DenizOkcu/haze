# Plan: improve LLM invocation of subagents

**Date:** 2026-07-31
**Depends on:** [context-isolation-contract.md](./context-isolation-contract.md)
**Scope:** how the main LLM decides to invoke `subagent`, how it constructs the handoff, and how it consumes the result. This plan does not implement the worker scheduler itself.

## 1. Problem

Current model-facing guidance defines `subagent` almost entirely as a parallelism tool:

- the system prompt says it is only for two or more independent tasks;
- the tool description repeats that restriction and says to spawn all workers in one step;
- the input is one unconstrained `task` string.

That framing hides the more general value: a disposable worker can absorb high-volume investigation without putting its reads, searches, command output, fetched documentation, and abandoned paths into the main conversation.

Invocation quality has three separate failure modes:

1. **Under-delegation:** the main agent performs noisy independent exploration directly because there is only one task.
2. **Over-delegation:** the main agent delegates trivial work where another model request and handoff cost more than the context saved.
3. **Bad handoff:** the parent sends a vague task or pastes excessive conversation/context into it, so the worker either fails or recreates the context bloat delegation was meant to prevent.

The invocation policy must work for capable cloud models and smaller/local tool-calling models without adding a large permanent prompt.

## 2. Desired model behavior

For each meaningful unit of work, the main LLM chooses one of three paths:

| Path | Use when |
|---|---|
| **Direct** | Work is small, tightly coupled to current conversation, needs user interaction, or its findings are immediately needed for the next tool call. |
| **One subagent** | Work is independently describable and likely to generate substantially more private context than the compact result needed by the parent. |
| **Fleet/multiple subagents** | Two or more independently describable, high-value tasks can run under scheduler limits. |

Parallelism is optional for `subagent`; independence and context-isolation value are mandatory.

## 3. Invocation decision policy

The main prompt should teach a short qualitative test, not a fake precise token formula.

### Delegate when all mandatory conditions hold

1. **Independent:** the task can be completed without main conversation history or an unfinished result from the parent/sibling.
2. **Self-contained:** the parent can state objective, deliverable, and likely scope compactly.
3. **High context-noise:** expected investigation is materially larger than the task capsule plus returned deliverable.
4. **Useful result boundary:** the parent needs a conclusion, patch, map, or evidence list—not the worker's complete transcript.

### Prefer delegation for

- broad repository surveys returning a compact map;
- large log/test-output diagnosis returning root cause and evidence;
- external documentation/API research returning only relevant conclusions;
- read-heavy audits returning findings with file/line evidence;
- comparing alternatives in a disposable context;
- noisy validation/debug loops returning final diagnosis;
- independent implementation with clearly bounded scope and output.

### Keep work direct when

- one or two targeted reads will answer it;
- the work depends on subtle conversation decisions that cannot be summarized compactly;
- the worker would need to ask the user questions;
- the next parent action depends on seeing intermediate results interactively;
- the task is sequentially dependent on unfinished parent/sibling work;
- task handoff plus result is likely as large as doing it directly;
- mutation scope is shared or uncertain and the active profile cannot isolate it.

### Multiple-worker rule

When several tasks pass the delegation test and are mutually independent, invoke them together so the coordinator can schedule them. Do not create artificial workers merely to reach a count. Do not split by arbitrary file ranges when one coherent investigation needs cross-file reasoning.

## 4. Proposed model-facing contract

Keep the tool name `subagent` for compatibility. Replace the free-form `task` input with a small, mostly flat schema that weak/local models can emit reliably.

### Recommended V1 schema

```ts
z.object({
  objective: z.string().min(1).max(1200),
  deliverable: z.string().min(1).max(600),
  mode: z.enum(['inspect', 'research', 'implement', 'validate']),
  scope: z.array(z.string().min(1).max(240)).max(12).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(300)).max(8).optional(),
})
```

Rationale:

- `objective` replaces an overloaded task essay.
- `deliverable` forces the parent to define the result boundary.
- `mode` lets code choose a safe prompt/tool profile; the LLM should not enumerate arbitrary tools.
- `scope` carries workspace path hints/research subjects as references, not copied contents.
- optional acceptance criteria carry only task-specific success constraints.
- capability selection, IDs, budgets, model choice, context loading, and concurrency belong to runtime policy—not model-generated input.

Avoid a deeply nested schema in the first release. A richer internal `SubagentTaskCapsule` can be constructed by code after validation.

### Proposed concise tool description

Implementation target—not final wording until scenario evaluation:

> Run independent work in a fresh disposable context and return only its deliverable. Use when private investigation (repository survey, logs, docs, audit, debugging, or bounded implementation) would add much more context than the result the main thread needs. One substantial task is enough; call multiple times together for genuinely independent tasks. Do not use for trivial work, sequential dependencies, user-interactive work, or tasks that require unsummarized conversation history.

This description communicates purpose, positive triggers, single-worker use, parallel use, and exclusions without embedding fleet scheduling rules.

### Proposed main-system-prompt rule

Add one compact paragraph near tool-use guidance:

> Use `subagent` as a context-isolation boundary. Delegate an independent, self-contained task when its private reads/searches/tool output are likely to be much larger than the compact deliverable needed here; one substantial task is sufficient. Keep trivial, conversation-coupled, user-interactive, or sequentially dependent work in the main thread. Give the worker a precise objective, deliverable, mode, and scope references—never paste conversation history or file contents into the handoff. For multiple independent tasks, submit them together and let runtime limits control concurrency.

Remove the existing “only for two or more” sentence. Do not copy the long list of examples into the permanent system prompt; examples belong in tests/evaluation fixtures and documentation.

## 5. Handoff construction rules

Before invoking the tool, the main LLM should transform relevant intent into a task capsule.

### Include

- one outcome-oriented objective;
- exact returned artifact/format;
- likely paths, modules, commands, URLs, or concepts to inspect;
- task-specific constraints and acceptance criteria;
- explicit instruction to report coverage gaps when scope may exceed budget.

### Exclude

- main conversation transcript or summary unless a specific decision is essential;
- copied file contents/tool output that the worker can retrieve;
- generic repository conventions already supplied through `AGENTS.md` logic;
- fleet scheduling/wave instructions;
- process narration such as “first read X, then think, then…” unless order is essential to correctness;
- secrets, provider configuration, or hidden controls;
- requests to return every detail encountered.

### Good handoff

```json
{
  "objective": "Determine why session resume can restore an incorrect terminal status. Follow project instructions for the session and streaming areas.",
  "deliverable": "Return a findings list with severity, file:line evidence, root cause, and the smallest recommended fix. State reviewed and unreviewed paths.",
  "mode": "inspect",
  "scope": ["src/core/session", "src/cli/commands/streaming", "tests/core/sessionStore.test.ts"]
}
```

### Bad handoff

```json
{
  "objective": "Read everything and help with the bug we discussed above. Here is the whole prior conversation and several file dumps...",
  "deliverable": "Tell me what you think",
  "mode": "implement"
}
```

The good handoff is independently actionable without reproducing the main thread.

## 6. Result-consumption policy

Invocation is not complete when the worker returns. The parent must consume the result without undoing context savings.

The main LLM should:

1. inspect termination, usability, truncation, and coverage gaps before trusting the deliverable;
2. use the compact deliverable directly rather than asking for the private transcript;
3. retrieve a detailed result handle only when necessary;
4. for edits, reconcile changed paths and validation against current workspace state;
5. report blocked/no-output/partial outcomes truthfully;
6. avoid repeating the complete worker deliverable and then restating it again;
7. launch a new narrowly scoped worker only when a real gap remains.

The result tool message should expose only the result capsule. Tokens, timing, retries, and tool-call logs remain available to UI/accounting out of band.

## 7. Runtime guardrails that improve invocation quality

Prompting alone is insufficient. Add deterministic feedback at the tool boundary.

### Validate capsule quality

Reject or return `policy_blocked` when:

- objective/deliverable exceeds limits;
- scope contains invalid/outside-workspace paths for workspace modes;
- requested mode is unavailable under active profile;
- capsule plus mandatory project context exceeds worker input budget;
- implement mode conflicts with mutation policy.

Return a concise recovery hint so the parent can narrow or keep the work direct.

Do not attempt semantic rejection such as “this seems trivial” in code; that remains an LLM judgment and evaluation concern.

### Runtime-owned behavior

The LLM must not choose or encode:

- provider/model fallback;
- concurrency cap or wave timing;
- deadline/retry policy;
- arbitrary tool names;
- project-instruction precedence;
- telemetry persistence;
- cross-worker locks.

Keeping these out of tool input reduces schema complexity and prevents weak models from being asked to manage runtime policy.

## 8. Cloud and local invocation behavior

### Cloud models

- The stronger parent can make richer delegation decisions, but the same compact schema limits prompt/tool-call cost.
- Explicit worker-model selection may route work economically; the invocation tool never silently chooses it.
- Account for extra request cost: do not delegate tiny inspections merely because workers are available.
- Provider cache settings should reduce repeated mandatory project-instruction cost.

### Local models

- Keep tool description and schema short, flat, and enum-driven.
- Do not require a model to emit an array of workers in one complex call; multiple ordinary tool calls can be scheduled by runtime.
- One context-isolation worker should work even if the endpoint cannot execute parallel calls.
- Runtime should serialize under `local-safe`, independent of whether the model emits several calls.
- If repeated capsule validation fails, give one compact correction and then keep work direct/report blocked; avoid repair loops.

The same semantic policy applies to both. Local optimization reduces schema/prompt complexity rather than weakening project instructions.

## 9. Implementation stages

### Stage 1 — change the framing

1. Replace parallel-only wording in `buildSystemPrompt` and `createSubagentTool`.
2. Introduce the flat capsule schema while accepting legacy `{task}` temporarily.
3. Convert both forms into one internal task capsule.
4. Add prompt/schema snapshot tests.

### Stage 2 — enforce lightweight handoffs

1. Add capsule limits and structured validation failures.
2. Independently assemble worker project context.
3. Choose toolset/prompt from `mode`.
4. Split model-facing result capsule from telemetry.
5. Add session/context-isolation tests.

### Stage 3 — improve multi-worker invocation

1. Route calls through the hard coordinator.
2. Let several tool calls in one parent step queue under runtime concurrency.
3. Remove model-authored wave/cap instructions.
4. Make `/fleet` produce validated capsules from its structured plan.

### Stage 4 — evaluate and tune

1. Add scenario fixtures for direct vs one-worker vs multi-worker decisions.
2. Run opt-in evaluations across representative cloud and local models.
3. Tune only concise system/tool wording based on observed failures.
4. Prefer runtime validation over adding permanent prompt paragraphs.

## 10. Test and evaluation plan

### Deterministic tests

- new schema accepts minimal valid inspect/research/implement/validate capsules;
- size/count/path limits reject malformed capsules with recovery hints;
- legacy `{task}` adapter works during migration and is later removed deliberately;
- captured worker request contains capsule only, no parent conversation/fleet controls;
- mode selects expected tools and prompt;
- result visible to parent excludes telemetry;
- several calls are coordinator-bounded regardless of model call count;
- single call works under concurrency one;
- session persistence contains only durable user prompt and result capsule.

### Invocation scenario evaluation

Use model evaluation fixtures; do not make paid-provider tests mandatory in CI.

| Scenario | Expected decision |
|---|---|
| Read one known 80-line file and answer one question | Direct |
| Diagnose a 20k-line log and return root cause | One inspect subagent |
| Research one external API across several docs | One research subagent |
| Audit auth, persistence, and fetch independently | Three subagents/fleet |
| Rename symbol then update dependent callers | Direct or dependency-aware fleet, not independent parallel calls |
| Ask user to choose product behavior | Direct; ask user |
| Edit same shared config from two tasks | Do not invoke concurrent implementation workers |
| Run broad tests and isolate failure evidence | One validate subagent |
| Apply a two-line known edit | Direct |

Score:

- decision correctness (direct/one/multiple);
- capsule self-containment;
- capsule size;
- absence of copied conversation/file content;
- useful-result rate;
- main-context tokens avoided estimate;
- invalid tool-call/repair rate;
- cloud/local latency and usage.

### Regression criterion

Do not ship wording that increases unnecessary delegation on simple coding tasks. Context isolation is valuable only when expected private context exceeds handoff/result overhead.

## 11. Implementation checklist

- [ ] Replace parallel-only main prompt rule with context-isolation decision policy.
- [ ] Replace tool description with concise purpose/triggers/exclusions.
- [ ] Add flat V1 capsule input schema and bounded fields.
- [ ] Add legacy task-string adapter and deprecation test.
- [ ] Construct runtime-owned internal capsule fields.
- [ ] Add mode-specific prompt/tool selection.
- [ ] Add structured validation/recovery results.
- [ ] Keep worker model/concurrency/deadline/tool policy out of LLM input.
- [ ] Split result capsule from out-of-band telemetry.
- [ ] Update `/fleet` planning to produce the same capsules.
- [ ] Add deterministic boundary tests.
- [ ] Add direct/one/multiple scenario evaluation fixtures.
- [ ] Evaluate at least one capable cloud model and one local model when available.
- [ ] Document that subagents optimize main-context quality, not only wall-clock speed.

## 12. Definition of done

- The main LLM may invoke one subagent for a substantial context-heavy independent task.
- It still avoids delegation for trivial, coupled, sequential, or interactive work.
- Every invocation states objective, deliverable, mode, and optional scope rather than one vague task essay.
- The worker receives no main conversation history, copied file dumps, sibling context, or fleet guidance.
- Applicable project instructions arrive through shared context-loading logic.
- Runtime—not the LLM—owns tools, model resolution, concurrency, retries, deadlines, and locks.
- Only a compact truthful result capsule returns to the parent model.
- Invocation scenario evaluations show acceptable decisions for both cloud and local models without materially increasing simple-task over-delegation.
