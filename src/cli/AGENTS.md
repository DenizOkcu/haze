# src/cli/AGENTS.md

Last updated: 2026-07-09.

CLI and terminal UI orchestration instructions.

## Responsibilities

- `index.ts` is the Commander entrypoint: parse flags, load package version, and dispatch to chat or headless command mode.
- `commands/chat.tsx` owns the interactive Ink screen, session lifecycle, slash command wiring, mode/picker state, input history, context refresh/signature tracking, tasks display, token display, abort handling, and debug logging.
- `commands/runCommand.ts` is the non-interactive/headless path; keep behavior aligned with interactive turns where practical.
- `commands/commands.ts` routes slash commands. Keep command matching simple and testable; complex behavior belongs in focused helper modules.
- `commands/*Wizard.ts`, `wizardActions.ts`, `wizardPrompts.ts`, `wizardInput.ts`, and `wizardSuggestions.ts` implement provider/LSP/MCP/skill picker flows. Keep them mostly pure and covered by unit tests.
- `chat/*.ts(x)` contains chat-specific helpers/components extracted from `chat.tsx`.

## UI state rules

Maintainability focus:

- Treat `commands/chat.tsx` as orchestration glue; prefer extracting session, wizard, and turn controllers over adding more inline branches.
- Avoid dead React state. If a value is not rendered or passed to durable logic, remove it rather than keeping setter-only state.

- Do not put durable business state only in React state. Sessions, settings, history, tasks, and logs must persist via their `config/` or `core/` modules.
- Keep refs for mutable turn/session machinery (`conversationRef`, abort controllers, logs, work state) when React rerenders must not reset them.
- `messages` and `liveMessages` are display state. Durable model conversation is `ModelMessage[]` in the conversation ref/session snapshots; session persistence may slim large values for disk without changing active in-memory turn state.
- Preserve display ordering when adding/updating messages; tests rely on stable ordering.
- Do not expose provider keys or secret settings in UI text.

## Slash command contracts

- `/provider`, `/model`, `/settings`, `/skills`, `/lsp`, and `/mcp` are user-facing flows; update help text and tests when changing them.
- `/clear` clears conversation display/conversation state and tasks.
- `/compact [instructions]` compacts model messages but should not persist synthetic control messages.
- `/logs` reads historical debug logs, but file LLM logging is only started when `--debug` is active.
- `/init` updates root project instructions; preserve useful user/project guidance.

## Agent-turn integration

- `runAgentTurn` is called with callbacks from `chat.tsx`; keep callback contracts stable.
- Interactive and headless paths should both inspect `TurnResult.status` instead of sniffing assistant text.
- Abort should stop the current turn cleanly and restore user control without corrupting session snapshots.
- Scoped context files discovered by tools are injected into the next model step through `runAgentTurn`; keep startup context display, signature maps, and tool UI “understanding:” rows in sync.
- Follow-up queue behavior must preserve user-submitted text and not lose messages during busy turns.

## Tests

- Update `tests/cli/commands.test.ts` for slash command changes.
- Update wizard tests for picker prompt/action changes.
- Update `tests/cli/formatters.test.ts` for display text changes.
- Update streaming tests for turn orchestration, token usage, tool grouping, assistant text filtering, and abort behavior.
