# src/cli/AGENTS.md

Last updated: 2026-08-19 for the 1.1.0 release.

CLI and terminal UI orchestration instructions.

## Responsibilities

- `index.ts` is the Commander entrypoint: parse flags, load package version, enforce the piped-stdin prompt byte cap, and dispatch to chat or headless command mode.
- `commands/chat.tsx` owns the interactive Ink screen: mode/picker state, input history, context refresh/signature tracking, tasks display, token display, abort handling, and debug logging. Session lifecycle and wizard submit dispatch are delegated to `chat/sessionLifecycle.ts` and `chat/wizardDispatch.ts` (CR-006).
- `commands/runCommand.ts` is the non-interactive/headless path; keep behavior aligned with interactive turns where practical.
- `commands/sessionPicker.ts` and `chat/sessionLifecycle.ts` own workspace session browsing, exact resume, and fork-from-snapshot behavior.
- `chat/fileMentionSuggestions.ts` provides bounded, gitignore-aware `@` completion; `chat/tips.ts` is the data registry for busy-state tips.
- `commands/commands.ts` routes slash commands. Keep command matching simple and testable; complex behavior belongs in focused helper modules.
- `commands/wizardFlow.ts` is the single source of truth for every picker/wizard step (kind, placeholder, optional-submit flag, suggestions, pure field captures); `chatModes.ts` derives the `Mode` union and picker/masked/empty-submit classification from its step table. `commands/providerWizard.ts`, `commands/serverWizard.ts`, `commands/skillsWizard.ts`, and `commands/themesCommand.ts` hold the pure per-domain result functions. Keep all of them mostly pure and covered by unit tests.
- `chat/*.ts(x)` contains chat-specific helpers/components extracted from `chat.tsx`: `sessionLifecycle.ts` (session init/continue/resume/new/clear/compact controller), `wizardDispatch.ts` (wizard submit engine: per-mode handlers, field-transition effects, and the `WizardUiState` reducer that owns selection/drafts/model-discovery state), `chatMetrics.ts` (token/status-bar math), and `messages.tsx` (ordered static/dynamic transcript partitioning and message views). `commands/streaming.ts` is the thin turn facade (`runAgentTurn` + turn types); the attempt phases (setup, stream loop, stall recovery, attempt outcome, forced-settlement lifecycle) live under `commands/streaming/` (see its AGENTS.md), including the authoritative `attemptOutcome.ts` status function.

## UI state rules

Maintainability focus:

- Treat `commands/chat.tsx` as orchestration glue; session and wizard behavior belong in `chat/sessionLifecycle.ts` / `chat/wizardDispatch.ts`. New wizard steps are added as one entry in the `WIZARD_STEPS` table in `wizardFlow.ts` (plus a submit handler in the dispatch engine when the step mutates anything), not as inline branches in `submit()`.
- Avoid dead React state. If a value is not rendered or passed to durable logic, remove it rather than keeping setter-only state.

- Do not put durable business state only in React state. Sessions, settings, history, tasks, and logs must persist via their `config/` or `core/` modules.
- Keep refs for mutable turn/session machinery (`conversationRef`, abort controllers, logs, work state) when React rerenders must not reset them.
- `messages` and `liveMessages` are display state. Durable model conversation is `ModelMessage[]` in the conversation ref/session snapshots; session persistence may slim large values for disk without changing active in-memory turn state.
- Preserve display ordering when adding/updating messages; tests rely on stable ordering. Ink `<Static>` items must remain an append-only ordered prefix. Once a live tail appears, later settled notices stay dynamic until that earlier tail finishes. The dynamic tail is clamped to a live-region row budget (`chat/liveRegion.ts`) so the frame never exceeds one viewport — beyond that, Ink's overflow fallback wipes scrollback and replays the whole transcript every render. Clamped streaming content is never lost: it enters `<Static>` verbatim once settled.
- Assistant streaming keeps the active root Markdown block plain and dynamic. Only parser-stable preceding roots enter `<Static>`; finalization commits the last root and completion metadata.
- Do not expose provider keys or secret settings in UI text.

## Slash command contracts

- `/provider`, `/model`, `/settings`, `/themes`, `/skills`, `/lsp`, and `/mcp` are user-facing flows; update help text and tests when changing them.
- `/themes` opens the built-in theme picker (`themes` mode, one `WIZARD_STEPS` row) or sets a theme directly with `/themes <name>`; `themesCommand.ts` holds the pure validation result (`resolveTheme`), the selection persists as `theme` in settings, and ChatScreen applies it live (re-resolve + OSC 10/11 re-apply on settings change).
- `/skills` displays every valid candidate, including shadowed global skills, with `project`/`global` provenance. Selection identity must remain unambiguous when names collide.
- Skill creation asks for scope explicitly after the name. `this project` writes under `<cwd>/.haze/skills`; `global` writes under `~/.haze/skills`. Never infer the target silently.
- `/clear` clears conversation display/conversation state and tasks.
- `/resume` and latest-session flows must omit sessions with no resumable messages. Starting or abandoning an empty session must not create a session JSONL file.
- `/fleet` persists its original invocation only; orchestration control and per-run profile/model/concurrency/review overrides are ephemeral and must be reapplied on retries without entering snapshots/events.
- `/compact [instructions]` compacts model messages but should not persist synthetic control messages.
- `/logs` reads historical debug logs, but file LLM logging is only started when `--debug` is active.
- `/init` updates root project instructions; preserve useful user/project guidance.
- `/tips` toggles the rotating tips under the busy label; persisted at `tips.enabled` (default `true`). Tips come from `chat/tips.ts` data, not code — reword or prune there.

## Agent-turn integration

- `runAgentTurn` is called with callbacks from `chat.tsx`; keep callback contracts stable.
- Interactive and headless paths should both inspect `TurnResult.status` instead of sniffing assistant text. `TurnResult.resume` (model-stream idle stall pause) is interactive-only; headless treats it as `failed` with the pause system message.
- Abort should stop the current turn cleanly and restore user control without corrupting session snapshots. User cancel, the absolute turn deadline, and model-stream idle stalls are distinguished causes (see `streaming/AGENTS.md`): only idle stalls retry, and an exhausted one pauses the turn with a one-key R resume affordance in chat.
- Scoped context files discovered by tools are injected into the next model step through `runAgentTurn`; keep startup context display, signature maps, and tool UI “understanding:” rows in sync.
- Announce discovered project skills as untrusted repository content. Slash-command suggestions and invocation must use the enabled project-over-global winner; disabling a project collision re-surfaces the enabled global skill.
- Follow-up queue behavior must preserve user-submitted text and not lose messages during busy turns.

## Tests

- Update `tests/cli/commands.test.ts` for slash command changes.
- Update wizard tests for picker prompt/action changes.
- Update `tests/cli/formatters.test.ts` for display text changes.
- Update streaming tests for turn orchestration, token usage, tool grouping, assistant text filtering, and abort behavior.
- Update `tests/cli/messages.test.tsx` when static/dynamic transcript partitioning, streamed Markdown promotion, or completion rendering changes.
