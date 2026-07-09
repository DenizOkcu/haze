# src/core/agent/AGENTS.md

Last updated: 2026-07-09.

Agent request assembly, compaction, budgets, events, work state, and tool-result helpers.

## Module contracts

Maintainability focus:

- `turnPolicy.ts` is the shared home for tool-loop/repeated-tool decision helpers used outside the UI. Do not reimplement these in subagents or CLI helpers.

- `budgets.ts` centralizes main agent/subagent step, tool-call, output-token, idle-timeout, and active-context limits. Changing values changes product behavior; update tests and docs if user-visible.
- `contextBudget.ts` contains approximate token estimation and breakdown helpers. Keep deterministic and cheap.
- `requestAssembly.ts` handles synthetic controls and active-conversation tool-history compaction. Synthetic `<haze_control>` messages are one-request nudges and must not be persisted as durable user conversation.
- `compaction.ts` compacts model messages with token budgets and embeds structured work state. It must preserve recent messages and enough task/tool context to continue safely.
- `toolResults.ts` contains guards and field helpers used by CLI, tool context, and request assembly. Keep guards tolerant of unknown provider/tool output shapes.
- `toolOutputStore.ts` stores process-scoped raw/reduced output handles. Handles are not durable session references and should be cleared for new sessions.
- `events.ts` defines structured agent events for sessions/headless/UI. Additive changes are preferred.
- `workState.ts` defines structured work state included in compaction/session snapshots.

## Compaction and protocol safety

- Never leave malformed AI SDK tool-call/tool-result pairs in compacted messages.
- Do not compact recent failures or recovery-relevant outputs away.
- For old successful outputs, keep metadata such as path, command, status, handles, counts, reducer names, validation summary, and token savings.
- Compact large mutating tool inputs (`writeFile`, `editFile`, `replaceLines`, long bash commands) only after they are old enough; preserve path and recovery hints.

## Tests

Use/update:

- `tests/core/agent.test.ts`
- `tests/core/requestAssembly.test.ts`
- `tests/core/contextBudget.test.ts`
- `tests/core/events.test.ts`
- `tests/core/workState.test.ts`
- `tests/core/agent/toolOutputStore.test.ts`
- streaming tests when behavior affects `runAgentTurn`.
