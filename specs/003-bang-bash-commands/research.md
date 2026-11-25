# Research: `!` Bash Command Execution

**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md) | **Status**: complete — no open questions

Findings come from reading the current source; nothing below was run. Line numbers are as of this plan.

## Context found in the codebase

| Area | Current state | Consequence for this feature |
|------|---------------|------------------------------|
| Input dispatch | `src/cli/chat/submitPipeline.ts` `submit()` runs: exit shortcut → settings repair → busy queue → wizard dispatch → skill invocation → slash commands → `prepareUserInput` → `doAgentTurn`. No `!` handling exists anywhere in `src/`. | The `!` branch is one new step in this pipeline. |
| Busy queue | While busy, chat input is queued by `followUps.queue(value)`. `src/cli/chat/agentTurnRunner.ts` drains it with `prepareUserInput(next)` and calls the agent turn directly — it never re-enters `submit()`. | A queued `!` line would be sent to the model as text unless the drain loop also recognises it. |
| Shell execution | `src/llm/tools/shellTool.ts` runs model commands through `runBoundedProcess` (`src/core/process/runBoundedProcess.ts`): stdin is `ignore`, stdout/stderr are byte-bounded, timeout and abort terminate the process tree, result carries `code`, `timedOut`, `aborted`, `forced`, `error`. Shell choice is `shellInvocation()` in `core/process/userShell.ts`. | Every bound in FR-006/007/008/FR-004 already exists in a core primitive. Reuse it; do not wrap the model tool (it needs an AI SDK tool context and records validation evidence). |
| Output reduction | `filterShellOutput` (`src/core/shellOutput/registry.ts`) with `fallbackCompact` + `COMPACT_COMMAND_CHARS` / `SHELL_STREAM_BYTES` from `core/limits.ts`; `storeToolOutput` keeps the raw text behind a handle. | Same reduction as model-run commands, with no change. |
| Env cleaning | `shellTool.ts` reads `settings.sanitizeProcessEnv` / `sanitizeProcessEnvExtra` and passes `sanitizeEnv`. | The `!` runner takes the same two settings as parameters. |
| Session redaction | Applied inside the session store when `redactSessionSecrets` is on. | Free, as long as the record is a normal conversation message. |
| Conversation entry | `src/cli/commands/streaming/attemptSetup.ts:179` builds the durable request as `[...stripSyntheticControls(conversation), userTurnMessage(value, attachments)]`. | A record appended before the turn would sit as a user message immediately before the new user message. |
| Session writes | `sessionRecorder.recordConversation(msgs)` writes a lossless `conversation_snapshot` through the private ordered writer; resume, continue and fork all restore from it. | Recording the `!` result as a conversation message satisfies FR-009 with no new session entry type. |
| Untrusted framing | `core/safety/untrustedEnvelopes.ts` has `escapeTagCloserVariants(content, tag)` for extra containers. | The record's closer can be escaped without touching the five built-in kinds. |
| Cancel | `cancelThinking()` aborts `abortControllerRef.current` when `busy`, then clears busy. | A `!` run that sets busy and installs its own controller in that ref is cancelled by Esc for free. |
| Screen size | `ChatScreen.tsx` is exactly at its pinned 450-line budget (`tests/cli/chat/chatScreenBudget.test.ts`). | Any line added to the screen must be paid for by an extraction. |

## Decisions

### D1 — Where the `!` result reaches the model
- **Decision**: Append the finished command as one user-role conversation message with plain string content, framed in a `<haze_user_command>` envelope. At turn start, fold any run of trailing user-command records into the new user turn message, so the provider still sees one user message per turn.
- **Rationale**: It is durable immediately (FR-009, resume/fork), protocol-safe (a string `ModelMessage`), and survives model switching. Folding keeps user/assistant alternation, which some OpenAI-compatible servers enforce.
- **Alternatives considered**:
  - *Leave consecutive user messages.* Less code, but risks HTTP 400 from strict servers. Rejected.
  - *Synthetic `<haze_control>` message.* Those are one-request nudges that are stripped from session state, the opposite of what FR-009 needs. Rejected.
  - *Forge an assistant tool-call + tool-result pair.* Breaks on model switching, which converts tool parts to text, and can trip the SDK's call/result pairing repair. Rejected.
  - *Hold the result in memory and prepend it to the next prompt.* Lost on restart. Rejected.

### D2 — How the command is executed
- **Decision**: A small runner in `src/cli/chat/userCommandRunner.ts` calls `runBoundedProcess` + `filterShellOutput` directly, taking settings, cwd and the abort signal as parameters. Pure helpers (input parsing, record framing, record folding) live in `core/` so they are unit-testable without React.
- **Rationale**: The model shell tool is coupled to the AI SDK tool context and to validation-evidence recording, which FR-015 forbids for `!`. `core/` must not import `config/`, so settings are passed in from `cli/`.
- **Alternatives considered**: calling the `shellTool.execute` with a fake context (couples to SDK internals and writes validation evidence); building a second process primitive (duplicates bounded teardown). Both rejected.

### D3 — Busy state and cancellation
- **Decision**: While the command runs, the screen is busy with the label `! <command head>`, and the run's `AbortController` is placed in `abortControllerRef`. Esc therefore cancels it; submissions during the run are queued like any other message.
- **Rationale**: Reuses the existing busy/cancel path with no new state.
- **Alternatives considered**: a separate "command running" state (new UI state and a second cancel route). Rejected.

### D4 — Timeout
- **Decision**: 60 seconds, the same default as the model-run shell tool, with no per-command override and no new setting.
- **Rationale**: The spec says reuse existing defaults and add no `!`-specific settings. Users who need longer runs use the model's shell tool or a background process.
- **Alternatives considered**: a `!timeout=` syntax or a setting. Both are scope the spec excluded.

### D5 — Validation evidence
- **Decision**: `!` runs never produce a `validationSummary`, never touch work state, and are not recorded as validation events.
- **Rationale**: FR-015. The runner simply omits the validation branch.

### D6 — Empty and escaped input
- **Decision**: A pure `parseUserInputLine` in `core/` returns one of `command` / `escaped` / `none`. `!` or `!` + whitespace → no command (system message). `\!…` → the text after the backslash is a normal message. Leading whitespace before `!` counts.
- **Rationale**: One pure function covers FR-001, FR-002, FR-013 and the listed edge cases, and is testable without React.

### D7 — Secrets
- **Decision**: No extra secret filtering for `!` beyond what model-run shell commands get: environment cleaning and session redaction apply; the command itself is not inspected.
- **Rationale**: FR-012 and the constitution's "expert-oriented, light guardrails" principle. The user runs with their own privileges, exactly as in a terminal.

## Risks

| Risk | Mitigation in plan |
|------|--------------------|
| Queued `!` lines bypass `submit()` via the follow-up drain. | The drain loop routes through the same parse step (T05). |
| `ChatScreen.tsx` line budget. | Runner is a separate module; only a deps entry is added to the screen. |
| A `!` record as the very first session content creates the session file. | Accepted: the record is resumable content. Noted in data-model.md. |
| Broken settings block `!`, since the env-cleaning settings cannot be read. | Accepted: the existing "repair settings" message is shown. |

## Not in scope (from the spec)

Headless runs, background `!` commands, `!` history / `!!` recall, any new setting.
