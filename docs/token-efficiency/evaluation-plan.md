# Token Efficiency Evaluation Plan

Research date: 2026-06-13

## Objective

Prove that token reductions do not materially weaken Haze's ability to understand requests, edit correctly, validate work, recover from errors, or sustain long agentic workflows.

Every experiment compares a candidate policy with the current implementation on both efficiency and capability. No candidate ships on token savings alone.

## Metrics

### Capability metrics

- **Task success** - requested final repository state is correct.
- **Instruction adherence** - project and user constraints are followed.
- **Edit correctness** - intended files change and unrelated files do not.
- **Validation behavior** - relevant checks run, failures are interpreted, and claims match evidence.
- **Context recall** - required prior facts remain available after pruning/compaction.
- **Recovery success** - stale or failed edits trigger a fresh read and correct retry.
- **Tool availability** - required tools remain selectable under any profile.
- **Final-answer evidence** - changed files, test status, blockers, and user decisions are reported when applicable.

### Efficiency metrics

- provider input and output tokens;
- estimated logical input tokens;
- no-cache, cache-read, and cache-write input tokens;
- effective billed input where pricing is known;
- static system and tool-schema tokens;
- retained tool-input and tool-result tokens;
- model-call and tool-call counts;
- repeated read/search/validation calls;
- time to first token and total wall time;
- context-compaction count and tokens removed;
- subagent tokens and handoff size;
- final-answer tokens.

### Stability metrics

- context overflow rate;
- provider protocol errors;
- malformed tool calls;
- duplicate tool-call rate;
- no-progress slices;
- incorrect completion/blocked classifications;
- variance across repeated live runs.

## Evaluation layers

### Layer 1: Deterministic unit tests

No model calls.

Test:

- context accounting;
- read/search/bash output bounds;
- no duplicated file content;
- tool-call/result pairing after pruning;
- preservation of failed and recent tool uses;
- synthetic control replacement;
- `WorkState` updates from tool events;
- token-threshold compaction;
- backward-compatible session restore;
- stable prompt and tool ordering;
- omission of tools on text-only calls.

### Layer 2: Offline trace replay

Feed recorded synthetic traces into each context policy and compare:

- tokens retained and removed;
- exact facts preserved;
- next action represented;
- protocol validity;
- expected cache-prefix hashes.

Fixtures must be secret-free and committed under `tests/fixtures/agent-traces/`.

### Layer 3: Mock-model agent tests

Use deterministic scripted model responses to verify orchestration:

- multiple tool steps;
- a failed edit followed by recovery;
- tool-only response followed by final synthesis;
- slice checkpoint and continuation;
- no-progress termination;
- compaction during an active goal;
- subagent handoff;
- skill loading.

### Layer 4: Live-model task evaluations

Run candidate and baseline against the same temporary repositories. Use at least:

- one strong coding model;
- one fast/lower-cost model;
- the default OpenRouter configuration or its current replacement at execution time.

Use temperature/provider defaults consistently. Run nondeterministic scenarios at least five times per variant when cost permits. Randomize candidate order to reduce time/provider bias.

### Layer 5: Manual review

Review a sample of traces for failures that aggregate scores hide:

- subtle instruction loss;
- unnecessary rereads caused by over-pruning;
- premature completion;
- terse but unhelpful final answers;
- cache optimization that increases latency or model calls;
- compaction summaries that silently change decisions.

## Scenario suite

### A. Direct answer without tools

Request a code explanation from supplied context.

Checks:

- no unnecessary tools;
- concise answer;
- project terminology retained;
- reduced output tokens.

### B. Single-file edit

Change one function and run a targeted test.

Checks:

- one focused read;
- one mutation;
- validation;
- no duplicate file content in context;
- concise final evidence.

### C. Cross-file feature

Implement a change touching three modules and tests.

Checks:

- repository discovery remains effective with bounded reads;
- task/work state tracks all required files;
- no relevant read is pruned before its edit;
- full suite is not run unnecessarily early.

### D. Edit recovery

Provide stale text so the first edit fails.

Checks:

- exact file is reread;
- recovery control is not persisted as a user request;
- corrected edit succeeds;
- failure remains in state only until resolved.

### E. Validation failure

Introduce or expose a targeted test failure.

Checks:

- compact bash output retains the first actionable diagnostics;
- unrelated output is omitted;
- the agent fixes and reruns once;
- full output can be retrieved when the summary is insufficient.

### F. Plan-only artifact

Ask Haze to research and create Markdown plans.

Checks:

- plan files are created;
- source implementation is not changed;
- final response does not repeat the plan contents;
- tool profile does not remove needed write capability.

### G. Large file navigation

Use a file larger than the default read page with relevant code near the end.

Checks:

- pagination metadata leads to the next page;
- the model does not assume the first page is the whole file;
- bounded output does not reduce success.

### H. Large command output

Run a command producing more than 100,000 characters with one relevant failure near the middle or end.

Checks:

- parser/tail retains the diagnostic;
- output handle retrieves omitted detail;
- later steps do not carry full output.

### I. Long-horizon migration

Synthetic repository migration requiring at least 60 tool actions across multiple phases.

Seed exact facts at different positions:

- user constraints near the beginning;
- an architecture decision after 15 steps;
- a failed approach after 25 steps;
- a validation command after 40 steps;
- one unresolved file after 50 steps.

Checks:

- all required facts survive two compactions;
- completed phase details are summarized but retrievable;
- next action remains correct;
- no context overflow;
- no linear growth in active context after steady state.

### J. Session resume

Pause after a compaction and restore the session.

Checks:

- goal and exact constraints restore;
- touched files and validation state restore;
- the first resumed action is correct;
- old session formats still load.

### K. Skill-heavy session

Create a registry with 1, 10, 50, and 100 synthetic skills.

Checks:

- schema growth by mode;
- correct skill selection;
- no material increase in wrong-skill calls;
- references are loaded only when requested.

### L. Subagent research

Split a task into three independent repository investigations.

Checks:

- parent chooses parallel delegation only when appropriate;
- subagents receive relevant instructions once;
- subagent token use falls;
- handoffs retain paths, findings, and validation evidence;
- parent context receives summaries rather than raw subagent traces.

### M. Nested project instructions

Use global, parent, and nearest-directory instruction files with one deliberate conflict resolved by scope/order.

Checks:

- critical directives are never dropped;
- context deduplication does not merge distinct rules;
- any manifest/summary mode matches the full-context baseline.

## Required fact recall test

Each long trace includes a machine-readable fact ledger:

```json
{
  "mustPreserve": [
    {"id": "constraint-no-dependency", "value": "Do not add dependencies"},
    {"id": "decision-parser", "value": "Use the existing output parser"},
    {"id": "failed-approach", "value": "Regex-only parsing failed on multiline diagnostics"},
    {"id": "next-file", "value": "src/core/validation/outputParser.ts"}
  ]
}
```

Score exact fields directly where possible. For free text, use a deterministic keyword/identifier check first and a calibrated pairwise model grader only for semantic equivalence.

## Experiment matrix

Run changes as ablations so the source of gains is visible.

| Variant | Prompt | Tool output | History | Skills | Cache |
| --- | --- | --- | --- | --- | --- |
| Baseline | Current | Current | Current | Per skill | Current |
| A | Concise | Current | Current | Per skill | Current |
| B | Current | Bounded | Current | Per skill | Current |
| C | Current | Current | WorkState/pruned | Per skill | Current |
| D | Concise | Bounded | WorkState/pruned | Per skill | Current |
| E | Concise | Bounded | WorkState/pruned | Catalog | Current |
| F | Concise | Bounded | WorkState/pruned | Catalog | Cache-aware |

Also compare all-tools, per-turn profile, and per-step profile variants separately. Do not combine tool-profile changes with unrelated prompt changes until their cache effect is understood.

## Acceptance gates

### Phase 1

- 100% deterministic tests pass.
- No task-success decrease on scenarios A-H in the strong-model runs.
- No more than 2 percentage points decrease on the fast model.
- At least 30% reduction in Haze-owned input tokens on scenarios B, E, and H.
- At least 20% median reduction in final-answer tokens.
- Zero missing changed-file or validation evidence in manual review.

### Phase 2

- At least 95% required-fact recall after each compaction.
- Scenario I completes in at least 90% of runs for both baseline and candidate, with candidate within 5 percentage points of baseline.
- Scenario J resumes correctly in all deterministic and at least 95% of live runs.
- Active logical context reaches a bounded steady state rather than growing with every tool call.
- No unmatched tool protocol messages.

### Phase 3

- Cache-supported runs show a higher cache-read ratio or lower effective billed input.
- Any dynamic tool profile produces net savings after cache effects.
- Skill selection remains within 2 percentage points of baseline at 50 and 100 skills.
- Nested instruction tests have zero critical misses.

## Regression interpretation

Investigate any candidate that saves tokens but causes:

- more model calls;
- more repeated reads;
- more edit failures;
- more broad validation commands;
- lower cache reuse;
- longer total latency;
- premature blocked/complete responses.

The correct unit is tokens per successful task, not tokens per request.

## Reporting template

For each candidate, record:

```text
Variant:
Model/provider:
Scenario set:
Runs:

Task success: baseline -> candidate
Required-fact recall: baseline -> candidate
Logical input tokens: baseline -> candidate
Non-cached input tokens: baseline -> candidate
Output tokens: baseline -> candidate
Model calls: baseline -> candidate
Tool calls: baseline -> candidate
Cache read ratio: baseline -> candidate
Wall time: baseline -> candidate

Regressions:
Manual trace notes:
Decision: reject | revise | advance
```

## Continuous evaluation

After rollout:

- add every confirmed context-loss or over-pruning bug as a fixture;
- run deterministic context tests in normal CI;
- run a small live smoke set before release candidates;
- run the full live matrix for changes to prompts, tool schemas/results, compaction, skills, or provider request assembly;
- publish measured deltas in release notes.

This follows the primary-source evaluation guidance to use task-specific production-like cases, log failures, automate scoring where possible, keep held-out cases, and continuously expand the suite.
