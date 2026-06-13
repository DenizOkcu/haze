# Token Efficiency Implementation Status

Implementation date: 2026-06-13

## Implemented

- Size-only context accounting for system policy, project files, tool schemas, message roles, tool inputs/results, and synthetic controls.
- Provider usage accounting for input, output, cache read/write, no-cache input, logical input estimate, and effective non-cached input.
- Bounded `readFile`, structured globally capped `grep`, compact bash output, and paginated full-output retrieval.
- Zero tool schemas on text-only continuation calls.
- Dedicated compact subagent prompts and concise parent completion guidance.
- Canonical `WorkState` updates from file and validation tools, persisted in session snapshots and embedded during compaction.
- Token-pressure compaction, protocol-safe recent tool boundaries, old successful-result pruning, bounded work slices, and two-slice no-progress termination.
- Replaceable `<haze_control>` messages that are removed before durable conversation snapshots.
- One progressive `skill` catalog tool instead of one schema per installed skill.
- Capability-gated OpenAI cache/verbosity hints and OpenRouter sticky-session hints.
- `npm run context:report` for tracked context files and secret-free offline traces.
- Project-context budget diagnostics: per-file tokens, aggregate totals, duplicate-content grouping, and a `HAZE_CONTEXT_BUDGET_SHARE`-gated `exceedsBudget` warning surfaced in `/settings` and `context:report`.
- Session-stable system prompt: date and working directory are computed once per session and threaded through main, continuation, retry, and subagent calls so the cache prefix stays byte-stable across multi-day sessions.

## Deterministic Evidence

The current repository context report is generated with:

```bash
npm run context:report
npm run context:report -- --trace tests/fixtures/agent-traces/long-workflow.json
```

Unit tests cover accounting stability, bounded file and command output, output retrieval, global grep limits, text-only request construction, synthetic-control replacement, protocol-safe tool-result pruning, token-aware compaction, work-state updates/restoration, progressive skill loading, and provider option gating.

Current deterministic measurements using the repository's four-characters-per-token estimate:

| Measurement | Pre-implementation | Current | Change |
| --- | ---: | ---: | ---: |
| Haze-owned static policy + core tool schemas | 4,133 | 2,442 | -40.9% |
| New-turn logical input with repository `AGENTS.md` | 8,249 | 6,629 | -19.6% |
| Old synthetic `readFile` result retained in trace | 472 | 59 | -87.5% |
| Full secret-free trace request | 3,260 | 2,847 | -12.7% |
| `context:report` output across two runs (date-stable) | drifts by date | byte-identical | cache prefix stable |

The trace keeps the latest three results and failures verbatim, so its total reduction is intentionally smaller than the single old-read reduction.

## Pending Live Gates

The following claims require configured providers and repeated model runs; they are not certified by the deterministic suite:

- task-success delta across strong and low-cost models;
- cache-hit and billed-input improvements on direct OpenAI and OpenRouter;
- 20-step and 60-step workflow token reductions;
- skill-selection accuracy with large registries;
- context-recall quality after repeated semantic compaction;
- provider-specific latency and malformed-tool-call rates.

Advanced learned compression, provider-native server compaction, and generated project-context summaries remain deferred until these gates pass.
