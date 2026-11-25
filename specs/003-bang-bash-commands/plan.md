# Implementation Plan: `!` Bash Command Execution

**Branch**: `003-bang-bash-commands` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-bang-bash-commands/spec.md`

## Summary

A line starting with `!` in the interactive prompt runs the rest of the line as a shell command immediately, without a model request. The command reuses the existing bounded process primitive and shell-output reducers (same shell, 60 s limit, byte bounds, env cleaning, Esc to cancel). When it finishes, the result is shown in the transcript and appended to the conversation as a labelled `UserCommandRecord` (see [data-model.md](data-model.md)), so the model can read it on the next turn and it survives save, resume and fork. `\!` escapes the prefix. No new tool, setting or session entry type.

## Technical Context

**Language/Version**: TypeScript (strict, ESM, `.js` import extensions), Node >= 22.13

**Primary Dependencies**: Existing only — React 19 + Ink (interactive UI), Vercel AI SDK `ModelMessage` (conversation shape), Vitest (tests)

**Storage**: Existing session JSONL via `conversation_snapshot` entries (`core/session`, written through `core/persistence`); no new storage

**Testing**: Vitest — `tests/core/**` for pure helpers, `tests/cli/chat/**` for the runner and screen wiring

**Target Platform**: Interactive terminal chat (`haze` TUI) on macOS, Linux and Windows (Git Bash/WSL shell rules unchanged)

**Performance Goals**: A command that finishes in under one second shows its output within one second of submission (SC-002); no model request is made (SC-001)

**Constraints**: `ChatScreen.tsx` stays at or below its pinned 450-line budget; every byte budget is a named constant in `core/limits`; no new setting; no confirmation gate

**Scale/Scope**: One new input branch, one runner module, one core helper module, one line changed in request assembly

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Phase-0 check

| Principle | Result | Evidence |
|-----------|--------|----------|
| I. Expert-oriented, light guardrails | ✅ Pass | No confirmation gate; classification stays metadata (FR assumption: runs as typed). |
| II. Minimal core, skills first-class | ✅ Pass | Adds no model-facing tool and no workflow feature; it is a core input primitive like `/` commands. |
| III. Bounded resources and lifecycles | ✅ Pass | Reuses `runBoundedProcess` (byte bounds, timeout, abort, tree teardown). Record text capped by named constants. |
| IV. Real-path boundaries and network safety | ✅ Pass | No file-tool change; shell is deliberately unfiltered (same as model shell). Output is framed as untrusted data with escaped closers. |
| V. Authoritative, truthful status | ✅ Pass | Run status derived once from runtime facts; exit code shown as-is. No turn status is inferred elsewhere. |
| VI. Deterministic, UI-agnostic core | ✅ Pass | Parse/frame/fold helpers are pure and live in `core/`; effects live in `cli/`. Serialized shape is a plain string `ModelMessage` — backward tolerant. |
| VII. Explicit configuration, no telemetry | ✅ Pass | No new setting, env var or default. |
| VIII. Private, ordered, durable state | ✅ Pass | Written only through `sessionRecorder.recordConversation` → private ordered writer; flushed after the record is appended. |
| IX. Controlled delegation | ✅ Pass (n/a) | No subagent involvement. |

### Post-Phase-1 re-check

Re-checked against [data-model.md](data-model.md) and [contracts/user-command.md](contracts/user-command.md):

- **III** — the record's command echo and output are each capped by named constants; `SHELL_STREAM_BYTES`, `COMPACT_COMMAND_CHARS` are reused. Still ✅.
- **IV** — the record is an untrusted-content envelope; its closer is escaped with the existing shared `escapeTagCloserVariants`, so no new escaper or envelope kind is added to the five built-ins. Still ✅.
- **V** — status precedence is fixed in one pure function (`error > cancelled > timed_out > completed > failed`). Still ✅.
- **VI / VIII** — fold happens in the request copy only; stored history is not rewritten. Still ✅.

No violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-bang-bash-commands/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # Spec quality checklist
├── contracts/
│   └── user-command.md  # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit-tasks - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── agent/
│   │   └── userCommands.ts                 # NEW (pure): parse, status, record, fold, transcript text
│   ├── limits.ts                           # EDIT: add the command-echo cap constant (if no existing cap fits)
│   └── process/
│       └── runBoundedProcess.ts            # unchanged (reused)
├── cli/
│   ├── chat/
│   │   ├── userCommandRunner.ts            # NEW (effects): execute + reduce, resolves with a run result
│   │   ├── userCommandFlow.ts              # NEW (orchestration): busy/cancel, transcript row, conversation record, flush
│   │   ├── submitPipeline.ts               # EDIT: route `!` and `\!` lines
│   │   ├── agentTurnRunner.ts              # EDIT: queued follow-ups route through the same parse
│   │   ├── screenDeps.ts                   # EDIT: one deps entry
│   │   ├── ChatScreen.tsx                  # EDIT: wire the deps entry (stay ≤ 450 lines)
│   │   ├── messages.tsx                    # EDIT: only if the tool-role row needs a caption
│   │   └── toolSummaries.ts                # EDIT: only if a summary builder is reused for the row
│   └── commands/
│       ├── streaming/
│       │   └── attemptSetup.ts             # EDIT: fold trailing records into the new user turn
│       └── commands.ts (+ help data)       # EDIT: `/help` entry
└── llm/
    └── systemPrompt.ts                     # EDIT: one sentence naming user-command records as data
README.md                                  # EDIT: document the `!` shortcut (repository root)


tests/
├── core/
│   └── userCommands.test.ts                # NEW
├── cli/
│   ├── chat/
│   │   ├── userCommandRunner.test.ts       # NEW
│   │   └── chatScreenBudget.test.ts        # existing (must stay green)
│   ├── commands.test.ts                    # EDIT: help entry
│   ├── commands/streaming.test.ts          # EDIT: fold at turn start
│   ├── readmeCommands.test.ts              # EDIT if it pins documented shortcuts
│   └── messages.test.tsx                   # EDIT if row rendering changes
```

**Structure Decision**: Single project, existing layout. Pure logic goes to `core/agent/userCommands.ts` (testable without React, importable by `cli/commands/streaming/attemptSetup.ts` for the fold). Effects go to a new `cli/chat/userCommandRunner.ts` because it needs settings passed in from `cli/` (`core/` must not import `config/`). The orchestration lives in a sibling `cli/chat/userCommandFlow.ts` over the existing `ChatScreenDeps` bundle, following the pattern already used by `submitPipeline.ts` and `agentTurnRunner.ts`.

## Work Items (superseded by `tasks.md`)

The authoritative, ordered task list is [tasks.md](tasks.md) (`T001`–`T025`). The items below are planning-level groupings with their own `W` prefix, so they never collide with task IDs.

| ID | Change | Requirements |
|----|--------|--------------|
| W01 | `core/agent/userCommands.ts`: `parseUserInputLine`, `userCommandStatus`, `formatUserCommandRecord`, `foldUserCommandRecords`, `userCommandTranscriptText` + tests | FR-001, 002, 013, 014, 016 |
| W02 | `core/limits.ts`: named constant for the command-echo cap, if no existing cap fits | Constitution III |
| W03 | `cli/chat/userCommandRunner.ts`: `runUserCommand` over `runBoundedProcess` + `filterShellOutput`, settings passed in, 60 s default inside the runner + tests | FR-003, 004, 006, 007, 011, 012, 015 |
| W04 | `cli/chat/userCommandFlow.ts`: busy label, abort controller in `abortControllerRef`, transcript row, append record to `conversationRef`, `recordConversation`, flush, follow-up queue drain | FR-005, 008, 009, 010, 016 |
| W05 | `submitPipeline.ts`: after wizard dispatch, in chat mode, route `command` / `escaped` / empty | FR-001, 002, 010, 013 |
| W06 | `agentTurnRunner.ts` follow-up drain: route queued lines through `parseUserInputLine` before `prepareUserInput` | Edge case: queued while busy |
| W07 | `screenDeps.ts` + `ChatScreen.tsx`: one deps entry, screen stays ≤ 450 lines | — |
| W08 | `attemptSetup.ts`: fold trailing records into the new user turn + streaming test | FR-009, FR-010 |
| W09 | `systemPrompt.ts`: one sentence that `<haze_user_command>` content is data | FR-014 |
| W10 | `/help` entry + README shortcut + `readmeCommands`/`commands` tests | Public contract |
| W11 | Full gates: `npm run typecheck && npm test && npm run lint && npm run build`; manual E2E per [quickstart.md](quickstart.md) | SC-001…006 |


Dependency order: W01, W02 → W03, W08 → W04 → W05, W06 → W07 → W09, W10 → W11 (task-level order lives in [tasks.md](tasks.md)).

## Key Design Points (from research)

- **Record placement** (D1): appended as a user-role string message right after the run; folded into the next user turn in the request copy so providers still see one user message.
- **Execution** (D2): direct call to the bounded process primitive — not the model's shell tool, which records validation evidence.
- **Cancel** (D3): the run's controller goes in `abortControllerRef`, so the existing Esc path cancels it.
- **Timeout** (D4): 60 s, same as the model shell tool, no override. The runner applies it itself whenever no limit is passed, so the default holds from the first slice.
- **Evidence** (D5): never a validation, never touches work state.
- **Secrets** (D7): same treatment as model-run shell commands; nothing extra.
- **Retrievable output** (D1): when reduced output was truncated and a stored handle exists, the record names it on a `full_output_handle:` line.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Queued `!` lines bypass `submit()` through the follow-up drain; input queued during a `!` run is never drained because the existing drain only runs after agent turns | W06 for agent-turn follow-ups; W04 drains the queue after every `!` run |
| `ChatScreen.tsx` at its 450-line budget | New logic in separate modules; W07 only adds a deps entry |
| Strict OpenAI-compatible servers reject consecutive user messages | Fold in W08 |
| Forged `</haze_user_command>` in command output ends the envelope early | Shared closer escaping in W01 (U9) |
| `!` as first session content creates the session file | Accepted; the record is resumable content |

## Complexity Tracking

> No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
