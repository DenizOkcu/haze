# Detailed simplification findings

## P0 — `ChatScreen` is doing too much

**File:** `src/cli/commands/chat.tsx`

`ChatScreen` currently owns all of these concerns at once:

- Ink rendering and layout.
- Message display ordering and live-message reconciliation.
- Provider/model wizard state.
- LSP wizard state.
- MCP wizard state.
- Skill wizard state and skill creation.
- Session creation/resume/compaction persistence.
- LLM log lifecycle.
- Input history.
- Task bar state and task cleanup.
- Slash command context wiring.
- Agent-turn queuing and cancellation.

This is the main complexity hotspot. The file is ~1,526 LOC and includes many repeated transitions back to `chat` mode. The code is understandable locally, but changes are risky because unrelated flows share component-local state and closures.

**Simplification direction**

Extract behavior in this order:

1. `chatSessionController.ts` — session/log/conversation persistence helpers.
2. `wizardController.ts` or one reducer per wizard — pure mode transitions and settings patches.
3. `chatTurnController.ts` — follow-up queue, cancellation, task refresh, call into `runAgentTurn`.
4. Keep `ChatScreen` mostly as state binding plus JSX.

**Tests first**

Before extraction, add characterization tests around the reducer/controller target behavior:

- Provider preset add, custom add, add/remove model, remove active provider.
- LSP preset/custom add, enable/disable, remove confirm/cancel.
- MCP preset/custom add, key set, enable/disable, remove confirm/cancel.
- Skill enable/disable/info/validate/remove confirm/cancel.

## P0 — Wizard flows duplicate the same state-machine shape

**Files:**

- `src/cli/commands/chat.tsx`
- `src/cli/commands/chatModes.ts`
- `src/cli/commands/wizardActions.ts`
- `src/cli/chat/inputSuggestions.ts`

Provider, LSP, MCP, and skill flows all implement variants of:

1. Choose existing item or add item.
2. Choose preset or custom.
3. Capture required fields.
4. Choose an action.
5. Enable/disable, set key, remove with `yes` confirmation.
6. Write settings and return to chat.

The source even labels LSP/MCP/Skills as mirroring the provider wizard. That is useful product consistency, but the implementation repeats branching and messages.

**Simplification direction**

Use a data-driven wizard definition instead of hand-coded branches for every resource:

- Resource adapter: `list`, `find`, `upsert`, `remove`, `setEnabled`.
- Common actions: `enable`, `disable`, `remove`.
- Optional actions: `set API key`, `add models`, `validate`, `show info`.
- Prompt definitions for each capture step.

Do **not** build a large generic framework. A small `createResourceWizard()` helper with explicit adapters is enough.

## P1 — Slash commands are a long imperative chain

**File:** `src/cli/commands/commands.ts`

`handleSlashCommand` is a single long sequence of `if` statements. This is still manageable today, but each new command increases the chance of ordering mistakes and makes help text drift from implementation.

**Simplification direction**

Replace the chain with a small command registry:

```ts
type SlashCommand = {
  names: string[];
  summary: string;
  match: (value: string) => false | {args: string};
  run: (args: string, ctx: CommandContext) => Promise<CommandResult> | CommandResult;
};
```

Generate `/help` from the registry so help text and behavior stay together. Keep special handling for unknown slash commands and non-slash text.

**Tests first**

Keep `tests/cli/commands.test.ts` as a characterization suite. Add one test that every registered command appears in `/help`.

## P1 — File tools repeat workspace and mutation boilerplate

**File:** `src/llm/hazeTools.ts`

The file tools repeat a similar envelope:

- Resolve workspace path.
- Check ignored state.
- Assert real/writable path inside workspace.
- Discover scoped context.
- Stop mutations when new scoped context appears.
- Catch errors and wrap with `structuredToolFailure`.
- Return scoped context when applicable.

This boilerplate is not merely verbose; it makes future tool changes error-prone because security and context-loading rules must be remembered in every tool.

**Simplification direction**

Introduce tiny wrappers, for example:

- `withWorkspaceReadTool(toolName, path, allowIgnored, recovery, fn)`
- `withWorkspaceMutationTool(toolName, path, allowIgnored, recovery, fn)`
- `withDirectoryTool(...)`

Keep business logic for `readFile`, `grep`, `editFile`, `replaceLines`, and `writeFile` explicit inside those wrappers.

**Tests first**

Run the existing tool tests after each extraction:

- `tests/hazeTools/readFile.test.ts`
- `tests/hazeTools/grep.test.ts`
- `tests/hazeTools/editFile.test.ts`
- `tests/hazeTools/replaceLines.test.ts`

## P1 — Collection normalization/upsert is inconsistent

**Files:**

- `src/config/providers.ts`
- `src/config/lspSettings.ts`
- `src/config/mcpSettings.ts`
- `src/config/settings.ts`

Providers, LSP servers, MCP servers, and skills all behave like named settings collections. Each module implements its own normalization and collection operations. This is fine while small, but details now diverge:

- `upsertProvider()` appends raw provider after filtering normalized providers.
- `upsertMcpServer()` appends raw server rather than `normalizeServer(server)`.
- `toggleMcpServer()` calls `upsertMcpServer(settings, ...)`, which recomputes from current settings rather than the already-normalized local list.
- LSP eagerly defaults `enabled: true`; MCP often omits `enabled` unless false.

These are subtle, likely behavior-compatible today, but they make edge cases harder to reason about.

**Simplification direction**

Add a small shared helper for named collections:

```ts
function upsertByName<T extends {name: string}>(items: T[], item: T): T[];
function removeByName<T extends {name: string}>(items: T[], name: string): T[];
function findByName<T extends {name: string}>(items: T[], name: string): T | undefined;
```

Each resource should still own its own normalization rules, but collection mechanics should be shared.

## P2 — Session and event persistence is scattered through UI callbacks

**Files:**

- `src/cli/commands/chat.tsx`
- `src/core/session/sessionStore.ts`
- `src/cli/commands/streaming.ts`

`runSingleAgentTurn()` wires persistence inline for UI messages, conversation snapshots, work-state snapshots, and events. This makes the UI callback block longer and couples message display to durable persistence.

**Simplification direction**

Create a small `SessionRecorder` adapter:

- `recordUiMessage(message)`
- `recordConversation(messages)`
- `recordWorkState(state)`
- `recordEvent(event)`

Then `runSingleAgentTurn()` can focus on translating agent callbacks into UI state.

## P2 — `TextInput` is a custom editor plus renderer in one component

**File:** `src/ui/components/TextInput.tsx`

`TextInput` is doing several hard things correctly: multiline wrapping, paste compaction, cursor mapping, history, suggestions, masking, and task toggling. The pure helper functions are already a good start, but the component still owns editor state transitions and rendering together.

**Simplification direction**

Extract a pure `inputBuffer` module that owns:

- `replaceInput`
- cursor movement
- paste block updates
- display/value cursor mapping
- history navigation decisions

Leave Ink rendering in `TextInput.tsx`.

**Tests first**

There is already `tests/ui/MarkdownText.test.ts`; add `tests/ui/TextInputBuffer.test.ts` for the extracted pure functions before changing the component.

## P2 — Verify potentially accidental duplicate behavior before changing

These may be intentional, but should be characterized before cleanup:

- `/clear` calls `clearConversation()` and then adds another `Cleared. The void is productive.` system message through the command handler. The visible transcript may get duplicate clear messages depending on the call path.
- `chatCommand()` clears task storage on startup and exit, while task storage is otherwise workspace-local and persistent. Confirm whether persistence across process restarts is desired.
- Provider/model direct selection permits `/model missing-name` to add that model to the active provider. This is useful but surprising compared with picker behavior; keep it if intentional, document it in tests/help.
