# Haze Token Efficiency Roadmap

Research date: 2026-06-13

This directory contains the research and implementation plan for reducing Haze's LLM input and output tokens without weakening repository understanding, tool reliability, or long-horizon autonomy.

## Documents

- [research.md](research.md) - repository audit, measured baseline, research synthesis, and design conclusions.
- [implementation-plan.md](implementation-plan.md) - phased implementation plan with file-level changes and rollout order.
- [evaluation-plan.md](evaluation-plan.md) - benchmark suite, metrics, quality gates, and experiment matrix.
- [implementation-status.md](implementation-status.md) - implemented controls, deterministic evidence, and live-evaluation gates still pending.

## Executive conclusion

Haze should not optimize primarily by making every prompt shorter. It should optimize the complete context lifecycle:

1. Stop creating duplicate tokens.
2. Keep stable, reusable prompt prefixes for provider caching.
3. Return bounded, high-signal tool results.
4. Replace old raw tool traffic with structured working state.
5. Compact by token pressure and completed work phase, not only after provider overflow.
6. Isolate expensive exploration in subagents only when it pays for itself.
7. Measure task success and context recall alongside tokens.

The safest first changes are concrete and local:

- `readFile` currently returns file content twice, once numbered and once unnumbered.
- A text-only follow-up still sends every tool schema even though `toolChoice` is `none`.
- Subagents receive a dedicated prompt plus the complete parent system prompt.
- File and bash outputs can remain in the conversation at up to tens of thousands of characters per call.
- Synthetic completion nudges are appended as user messages and can accumulate across loop slices.
- Every installed skill becomes a separate tool schema on every request.

## Pre-implementation baseline

Measurements use Haze's existing approximation of four characters per token. They are useful for relative comparisons, not billing.

| Component | Characters | Approximate tokens |
| --- | ---: | ---: |
| Base Haze system prompt | 8,752 | 2,188 |
| Repository `AGENTS.md` | 15,942 | 3,986 |
| System prompt with this repository context | 25,216 | 6,304 |
| Eight built-in tool descriptions and JSON schemas | 7,778 | 1,945 |
| Subagent tool description and schema | 1,000 | 250 |

A new turn in this repository therefore starts at roughly 8.5k logical input tokens before conversation history, the user request, installed skill schemas, or tool results. Provider prompt caching may reduce billed input, but it does not remove attention pressure or context-window use.

## Target outcomes

Targets are gates for the implementation, not claims about savings before measurement.

- Reduce Haze-owned static overhead, excluding project context, by at least 35%.
- Reduce typical `readFile` result tokens by at least 45% with no loss of editable line information.
- Send zero tool schemas on final text-only synthesis calls.
- Reduce non-cached input tokens by at least 40% on a 20-step coding workflow.
- Reduce median final-answer output tokens by at least 30% while preserving changed-file and validation evidence.
- Keep task completion within 5 percentage points of baseline across the live-agent evaluation set.
- Preserve at least 95% of required facts after compaction in long-horizon recall tests.
- Complete a 60-step synthetic workflow without context overflow or loss of the active goal.

## Priority order

| Priority | Work | Expected risk |
| --- | --- | --- |
| P0 | Add exact context accounting and a repeatable eval harness | Low |
| P1 | Remove duplicate payloads and tools from text-only calls | Low |
| P1 | Bound `readFile`, `grep`, and `bash` output with continuation handles | Low to medium |
| P1 | Replace the duplicated subagent prompt with a compact dedicated prompt | Low |
| P2 | Shorten repeated system/tool guidance and task-update requirements | Medium |
| P2 | Add structured `WorkState` and prune completed tool traffic | Medium |
| P2 | Add automatic phase and token-pressure compaction | Medium |
| P3 | Consolidate skill discovery and evaluate intent-based tool profiles | Medium |
| P3 | Add provider-specific cache keys, sticky sessions, and compaction adapters | Medium |
| Deferred | Learned prompt compression or lossy semantic compression | High |

## Central constraint

Token reduction is accepted only when task success, instruction following, edit correctness, validation behavior, and long-horizon state retention remain within the gates in [evaluation-plan.md](evaluation-plan.md). A smaller prompt that causes another model call, repeated file reads, or a failed edit is not an optimization.
