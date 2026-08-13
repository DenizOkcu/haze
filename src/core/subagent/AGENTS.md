# src/core/subagent/AGENTS.md

Last updated: 2026-08-13 for the 0.10.1 release.

Subagent runner and model-facing subagent tool.

## Purpose

Subagents are disposable context-isolation workers for one or more independently describable tasks. They receive no parent/sibling conversation and return only a compact result capsule to the parent model. `/fleet` is an ephemeral parallel-only wrapper over this same primitive, not a second orchestration engine.

## Contracts

Maintainability focus:

- Reuse shared agent policy helpers such as `toolOnlyStepCount` from `core/agent/turnPolicy.ts`; subagents should differ by caps/prompt, not duplicated logic.

- Do not use subagents for simple sequential tasks or tasks that need active conversation context.
- Keep the model-facing input schema as one flat required `objective`/`deliverable`/`mode` object. Do not reintroduce a legacy union: local OpenAI-compatible models have emitted empty `{}` calls for union tool schemas.
- Do not declare a subagent `contextSchema` unless the main turn also supplies matching `toolsContext`; orchestration currently uses only the standard tool execution abort signal.
- Tools are selected by the fixed inspect/research/implement/validate mode map; never pass arbitrary model-authored tool names through unchecked.
- Project context is independently assembled with shared root/scoped/signature logic; never copy the parent's accumulated subtree context.
- Keep hard caps on input, deadline, max steps, tool-only loops, summary length, tool calls, retries, and concurrency. Enforce tool caps at each actual execution, not only between model steps.
- Deadline/cancellation returns logical control immediately, but abort-ignoring execution is quarantined and must retain its physical concurrency/mutation slot until it settles; events must distinguish terminal delivery from physical settlement.
- V2 termination is authoritative (`completed`, `no_output`, limits, deadline, cancellation, provider error, policy block); retain the V1 raw projection only for compatibility.
- Only the result capsule enters parent model context. Telemetry is bounded/out-of-band, and result handles are process-local.
- Mutation-capable workers share a turn-scoped reentrant workspace policy and are serialized.
- Tool-call logs should be compact summaries, not full raw outputs.
- Subagent prompt construction lives in `llm/systemPrompt.ts`; keep tool runner and prompt behavior in sync.

## Tests

Update `tests/core/subagent/subagentRunner.test.ts` for tool allowlist, budget, status, summary, and error behavior.
