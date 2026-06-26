# Behavior-preserving simplification plan

This plan is intentionally incremental. Each step should be test-backed and independently shippable.

## Guardrails

- Preserve all CLI-visible messages unless a test proves a message is duplicated or accidental.
- Do not introduce a broad plugin framework or dependency injection container.
- Prefer pure reducers/helpers over classes unless lifecycle management demands an object.
- Keep React/Ink in UI files; move business rules out.
- Run focused tests after each step, then full validation before merging.

## Phase 1 — Characterization tests

Add tests before moving code.

1. Wizard behavior tests
   - Target new pure modules, but start by codifying expected transition tables.
   - Cases: provider, LSP, MCP, skills add/action/remove flows.
2. `/clear` behavior test
   - Decide whether duplicate clear messages are current behavior or a bug.
3. Settings collection tests
   - `upsertProvider()` normalizes or intentionally preserves raw inputs.
   - `upsertMcpServer()` normalizes or intentionally preserves raw inputs.
   - Enable/disable defaults for LSP/MCP.
4. Text input pure-buffer tests before extracting editor mechanics.

Suggested commands:

```bash
npm run typecheck
npm test -- tests/cli/commands.test.ts tests/config/providers.test.ts tests/config/lspSettings.test.ts tests/config/mcpSettings.test.ts
```

## Phase 2 — Extract wizard reducers from `chat.tsx`

Create small modules under `src/cli/commands/wizards/`:

- `providerWizard.ts`
- `lspWizard.ts`
- `mcpWizard.ts`
- `skillWizard.ts`
- shared `resourceWizard.ts` only after two extractions prove the common shape.

A reducer result should be boring and explicit:

```ts
type WizardResult = {
  mode?: Mode;
  settingsPatch?: Partial<HazeSettings>;
  systemMessage?: string;
  clearDrafts?: boolean;
};
```

Keep side effects such as `updateSettings()`, `refreshSkills()`, and `fs.remove()` at the boundary until they can be isolated safely.

## Phase 3 — Extract chat session and turn adapters

1. Add `src/cli/chat/sessionRecorder.ts`.
2. Add `src/cli/chat/turnController.ts` for follow-up queue/task refresh orchestration if it remains simple.
3. Shrink `runSingleAgentTurn()` to callback wiring plus calls into the recorder.

Focused tests:

```bash
npm test -- tests/core/sessionStore.test.ts tests/cli/turnRuntime.test.ts tests/cli/toolResultState.test.ts
```

## Phase 4 — Simplify slash command registry

Refactor `handleSlashCommand()` into a command table.

Acceptance criteria:

- Existing command tests pass unchanged.
- `/help` is generated from registered commands.
- Unknown slash commands still return `handled` with the existing style of message.
- Non-slash input still returns `unhandled`.

Focused tests:

```bash
npm test -- tests/cli/commands.test.ts
```

## Phase 5 — Extract file-tool envelopes

Add wrappers for common path/ignored/scoped-context/error handling. Move one tool at a time:

1. `readFile` first (read-only, simple).
2. `writeFile` second (mutation guard).
3. `replaceLines` and `editFile`.
4. `grep` last because it has additional ripgrep parsing and output compaction.

Focused tests:

```bash
npm test -- tests/hazeTools/readFile.test.ts tests/hazeTools/editFile.test.ts tests/hazeTools/replaceLines.test.ts tests/hazeTools/grep.test.ts
```

## Phase 6 — Shared named-collection helpers

Introduce `src/utils/collections.ts` or `src/config/collections.ts` with tiny generic helpers only.

Refactor provider/LSP/MCP modules to use it while keeping each module's normalization local.

Focused tests:

```bash
npm test -- tests/config/providers.test.ts tests/config/lspSettings.test.ts tests/config/mcpSettings.test.ts tests/config/skillSettings.test.ts
```

## Phase 7 — Extract `TextInput` buffer logic

Move pure editor operations out of the React component.

Acceptance criteria:

- Component rendering stays unchanged.
- Pure buffer functions are covered directly.
- Existing keyboard behavior is unchanged in tests/manual smoke.

## Implementation status (2026-06-26)

All planned phases are implemented.

| Phase | Status | Notes |
|---|---|---|
| 1 — Characterization tests | Done | Added direct helper tests; existing test coverage preserved. |
| 2 — Extract wizard reducers from `chat.tsx` | Done | `providerWizard.ts`, `lspWizard.ts`, `mcpWizard.ts`, `skillWizard.ts`. |
| 3 — Extract chat session and turn adapters | Done | `sessionRecorder.ts`, `turnState.ts`. |
| 4 — Slash command registry | Done | Table-driven `SLASH_COMMANDS` in `commands.ts`. |
| 5 — File-tool envelopes | Done | `tools/workspaceFile.ts` (`prepareWorkspaceRead`, `prepareWorkspaceMutation`, `prepareWorkspaceWritePath`, `prepareWorkspaceExisting`). |
| 6 — Named-collection helpers | Done | `src/utils/collections.ts` reused by provider/LSP/MCP/skill settings. |
| 7 — TextInput buffer | Done | `src/ui/inputBuffer.ts` with direct unit tests. |

### Remaining nice-to-haves (not in plan)

- `chat.tsx` (~1,248 lines) can be split further once wizard reducers stabilize.
- `hazeTools.ts` still contains inline grep parsing/rendering; a later refactor could extract it.
- Manual smoke via `npm run dev` is impractical to run inside this review.

## Final validation

Before merging all simplification work:

```bash
npm run typecheck
npm test
npm run lint
```

If packaging or release files change, also run:

```bash
npm run build
npm pack --dry-run
```
