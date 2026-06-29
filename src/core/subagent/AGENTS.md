# src/core/subagent/AGENTS.md

Subagent runner and model-facing subagent tool.

## Purpose

Subagents are for independent parallel investigations/actions with no conversation history. They summarize back to the main agent.

## Contracts

- Do not use subagents for simple sequential tasks or tasks that need active conversation context.
- Allowed subagent tools are a fixed allowlist from built-ins; never pass arbitrary tool names through unchecked.
- Keep hard caps on max steps, tool-only loops, summary length, and tool-call counts.
- Subagent status values are `ok`, `error`, `timeout`, and `cancelled`.
- Abort signals should return `cancelled` where possible.
- Tool-call logs should be compact summaries, not full raw outputs.
- Subagent prompt construction lives in `llm/systemPrompt.ts`; keep tool runner and prompt behavior in sync.

## Tests

Update `tests/core/subagent/subagentRunner.test.ts` for tool allowlist, budget, status, summary, and error behavior.
