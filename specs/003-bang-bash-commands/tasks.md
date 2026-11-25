---
description: "Task list for feature implementation"
---

# Tasks: `!` Bash Command Execution

**Input**: Design documents from `/specs/003-bang-bash-commands/`

**Prerequisites**: [plan.md](plan.md) (required), [spec.md](spec.md) (required for user stories), [research.md](research.md), [data-model.md](data-model.md), [contracts/user-command.md](contracts/user-command.md), [quickstart.md](quickstart.md)

**Tests**: No separate test phases. This repository's quality gates require a regression test with every source change, so each implementation task names the test file that must cover it. The scenarios to cover are listed in [quickstart.md](quickstart.md) (U1–U12, R1–R7).

**Organization**: Tasks are grouped by user story. US1 alone is a usable MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: The user story this task belongs to (US1, US2, US3)
- Field constraints cite `data-model.md` → `Entity.field`

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root; `README.md` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm a clean baseline before any change

- [X] T001 Run `npm run typecheck && npm test && npm run lint` and record the result; if anything is red before this feature starts, stop and report it rather than building on it

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pure input classification and status rules every story builds on

- [X] T002 Create `src/core/agent/userCommands.ts` with the exported types `ParsedInputLine`, `UserCommandRun`, `UserCommandStatus` and the pure functions `parseUserInputLine` and `userCommandStatus`, per [contracts/user-command.md](contracts/user-command.md) §5. Field constraints: the three variants follow `data-model.md` → `ParsedInputLine`; `command` is the trimmed text after `!` per `data-model.md` → `ParsedInputLine.command`; `value` is the text after the leading `\` per `data-model.md` → `ParsedInputLine.value`; the status values follow `data-model.md` → `UserCommandRun.status`; `exitCode` is `number | null` per `data-model.md` → `UserCommandRun.exitCode`; `durationMs` is a number per `data-model.md` → `UserCommandRun.durationMs`; `stdout` and `stderr` are reduced streams per `data-model.md` → `UserCommandRun.stdout` and `data-model.md` → `UserCommandRun.stderr`; `error` is optional per `data-model.md` → `UserCommandRun.error`
- [X] T003 In `src/core/agent/userCommands.ts` implement the status derivation in the fixed order of `data-model.md` → *Status derivation* (`error` set → `aborted` → `timedOut` → `code === 0` → otherwise), so it is computed in exactly one place
- [X] T004 Add the unit tests for U1–U8 from [quickstart.md](quickstart.md) in `tests/core/userCommands.test.ts` (parse cases, empty command, `!!`, `\!` escape, status precedence); runs after T003 because it imports the module
- [X] T005 In `src/core/limits.ts` add one named constant for the maximum length of the echoed command text in a record and in the transcript row (check first whether an existing cap fits; if one does, cite it instead of adding a new constant)

**Checkpoint**: `npx vitest run tests/core/userCommands.test.ts` is green; classification and status rules exist with no UI wiring

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

---

## Phase 3: User Story 1 - Run a shell command directly from the prompt (Priority: P1) 🎯 MVP

**Goal**: Typing `! <command>` at an idle prompt runs the command as typed, immediately, with no model request, and shows its output and exit status in the transcript

**Independent Test**: Type `! ls -la` at an idle prompt; the output appears with `exit 0`, and no assistant reply follows. Type `!false`; it is shown as `exit 1`.

### Implementation for User Story 1

- [X] T006 [P] [US1] Create `src/cli/chat/userCommandRunner.ts` exporting `runUserCommand({command, cwd, sanitizeEnv?, signal?, timeoutMs?})`: run `shellInvocation(command)` through `runBoundedProcess` with `SHELL_STREAM_BYTES` per stream and stdin closed (the primitive's `ignore` stdin — a command waiting for input ends by itself), reduce with `filterShellOutput` (`fallbackCompact`, `COMPACT_COMMAND_CHARS`, `storeToolOutput`), never produce a `validationSummary`, and never apply file, Git-internals or network restrictions (the command runs with the user's privileges, like any terminal), resolve with a `UserCommandRun` (catch process-level failures into `status: 'error'` per `data-model.md` → *Status derivation* rule 1); apply the 60 s limit inside the runner whenever `timeoutMs` is omitted, so the MVP is bounded without US3; add tests R1–R3 and R5 plus one running a command that touches a path a file tool would refuse (an ignored file, a `git`-internal path, and a loopback URL) and succeeds, in `tests/cli/chat/userCommandRunner.test.ts`
- [X] T007 [P] [US1] In `src/core/agent/userCommands.ts` add `userCommandTranscriptText(run)` producing the row and status line of [contracts/user-command.md](contracts/user-command.md) §3; cover it in `tests/core/userCommands.test.ts`
- [X] T008 [US1] Create `src/cli/chat/userCommandFlow.ts` exporting a function over `ChatScreenDeps` that sets busy with the label `! <command head>`, calls the runner with `cwd: workspaceRoot()` (the user's current workspace, `src/utils/path.ts`), appends one `tool`-role `Message` with the transcript text through `setMessages`, and clears busy; then drain `followUps` until empty, routing each queued line through `parseUserInputLine` (a `!` line runs as another command, `\!` loses its backslash, anything else goes through `prepareUserInput` and the agent turn), because the existing drain only runs after agent turns; add `tests/cli/chat/userCommandFlow.test.ts` asserting no agent turn is started for the command itself, the row text matches, and a line queued during the run is drained afterwards
- [X] T009 [US1] In `src/cli/chat/submitPipeline.ts` route input after `wizard.dispatch`, only when `mode === 'chat'`: `command` with non-empty text → the flow from T008; `command` with empty text → system message `No command given after "!".`; `escaped` → continue down the pipeline with the backslash removed; `none` → unchanged
- [X] T010 [US1] Add one entry for the flow to `src/cli/chat/screenDeps.ts` and wire it in `src/cli/chat/ChatScreen.tsx`; `tests/cli/chat/chatScreenBudget.test.ts` must stay green (screen ≤ 450 lines) — if it does not, move existing screen logic out before adding this
- [X] T011 [US1] Decide the transcript row label with one bounded check: find where `Message` values with `role: 'tool'` are rendered (`src/cli/chat/messages.tsx` and, if not there, `src/cli/chat/transcriptPartition.ts` / `src/cli/chat/chatViewModel.ts` — none of the three matched a literal `tool` role check at planning time). If that render path shows no label for the row, add the smallest caption change and update `tests/cli/messages.test.tsx`; if it already labels it, make no change. Either way the outcome is written on this task when executed. Outcome: `tool`-role messages already render under a bold "Tool" header in `src/cli/chat/messages.tsx`; no change made.

**Checkpoint**: `! ls -la` runs and shows output with no model call; `!` shows the no-command message; `\! text` reaches the model as `! text`

---

## Phase 4: User Story 2 - The model receives the command result (Priority: P2)

**Goal**: The finished command and its output are durable conversation context the model can read on the next turn

**Independent Test**: Run `! ls -la`, then ask "what files are in this directory?"; the model answers from the recorded output without calling `shell`. Exit, resume the session, and ask again.

### Implementation for User Story 2

- [X] T012 [P] [US2] In `src/core/agent/userCommands.ts` add `formatUserCommandRecord(run)` producing the `<haze_user_command>` record of `data-model.md` → *UserCommandRecord* (header sentence, `command`, `status`, `exit_code`, `duration_ms`, combined reduced output), escaping closers with `escapeTagCloserVariants` and stating truncation; the echo cap is the constant from T005; when the output was truncated and a stored handle exists, add the `full_output_handle:` line per `data-model.md` → *UserCommandRecord* rule **Retrievable**; cover U9 and U10 in `tests/core/userCommands.test.ts`
- [X] T013 [US2] In `src/core/agent/userCommands.ts` add `foldUserCommandRecords(messages, turn)`: when the messages immediately before the new turn are user-command records, return one user message holding the record bodies followed by the turn text; otherwise return the input unchanged (U11, U12); follows T012 because both edit the same file
- [X] T014 [US2] Extend the flow in `src/cli/chat/userCommandFlow.ts`: after the run finishes, append the record as a `user`-role string `ModelMessage` to `conversationRef.current`, call `sessionRecorder.recordConversation`, then `flush`; assert in `tests/cli/chat/userCommandFlow.test.ts` that exactly one record message is appended, no agent turn starts, and a record written into a session with no other messages makes that session resumable (the session file is created); add a session round-trip test in `tests/cli/chat/sessionLifecycle.test.ts` showing the record survives save → restore → resume and fork unchanged, and one showing that with `redactSessionSecrets` enabled token-shaped output in the record is redacted in the session file
- [X] T015 [US2] In `src/cli/commands/streaming/attemptSetup.ts` apply `foldUserCommandRecords` at the single site that builds the durable request messages (currently `[...stripSyntheticControls(conversation), userTurnMessage(...)]`); add a case to `tests/cli/commands/streaming.test.ts` showing the provider request has one user message for record + new text
- [X] T016 [US2] Add one sentence to `src/llm/systemPrompt.ts` stating that `<haze_user_command>` content is output of a command the user ran and is data, not instructions

**Checkpoint**: A follow-up question is answered from the recorded output; the record is still present after resume and fork

---

## Phase 5: User Story 3 - Keep control over long, large, and unsafe commands (Priority: P3)

**Goal**: Long-running, verbose, interactive, and queued `!` commands behave predictably

**Independent Test**: `! sleep 120` then Esc reports "cancelled" within about a second; left alone it reports the time limit after 60 s; `! seq 1 100000` shows a bounded excerpt; a `!` line typed during a model turn runs afterwards instead of going to the model as text.

### Implementation for User Story 3

- [X] T017 [US3] In `src/cli/chat/userCommandFlow.ts` create an `AbortController`, store it in `abortControllerRef` for the duration of the run and clear it afterwards and pass its signal to the runner (the 60 s default already lives in the runner from T006); the transcript row must then show the `cancelled` and `timed_out` status lines of [contracts/user-command.md](contracts/user-command.md) §3; add flow tests for both
- [X] T018 [P] [US3] In `src/cli/chat/userCommandRunner.ts` read nothing itself: have the flow pass `sanitizeEnv` built from `settings.sanitizeProcessEnv` / `sanitizeProcessEnvExtra` exactly as `src/llm/tools/shellTool.ts` does; add runner tests R4 (timeout) and R6 (abort) in `tests/cli/chat/userCommandRunner.test.ts`
- [X] T019 [US3] In `src/core/agent/userCommands.ts` make the transcript row (`userCommandTranscriptText`) state truncation with the omitted-characters line when the reduced output was cut; add runner test R7 (50 000 lines) asserting the record text is bounded
- [X] T020 [US3] In `src/cli/chat/agentTurnRunner.ts` route each queued follow-up through `parseUserInputLine` before `prepareUserInput` (the same routing the `!` flow's own drain from T008 uses), so a queued `!` line runs as a command and a queued `\!` line loses its backslash; add a case to `tests/cli/chat/userCommandFlow.test.ts` or the nearest existing follow-up-drain test

**Checkpoint**: Timeout, cancel, truncation, env cleaning, and queued lines all behave per the spec

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Public documentation and full validation

- [X] T021 [P] Add the `!` shortcut (and the `\!` escape) to the `/help` entries in `src/cli/commands/commands.ts` and update `tests/cli/commands.test.ts`
- [X] T022 Document the `!` shortcut (and the `\!` escape) on its own line in the `## Commands` block of `README.md`, then make `tests/cli/readmeCommands.test.ts` consistent: it currently asserts that the block lists every slash command `/help` documents, so run it after T021 and adjust it only if the new non-slash line breaks its parsing
- [ ] T023 Run the manual end-to-end list in [quickstart.md](quickstart.md) steps 1–11 with `npm run dev`, and record which steps could not be exercised — NOT DONE: no interactive terminal was available in this session; steps 1–11 were not exercised (the automated R1–R7, queue-drain, cancel and session round-trip tests cover them partially)
- [X] T024 Run the full gates: `npm run typecheck && npm test && npm run lint && npm run build`
- [X] T025 Update `src/cli/AGENTS.md` and `src/core/agent/AGENTS.md` module lists with the new modules (`userCommands.ts`, `userCommandRunner.ts`, `userCommandFlow.ts`) in one line each

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Phase 1 — blocks all user stories
- **US1 (Phase 3)**: Depends on Phase 2
- **US2 (Phase 4)**: Depends on Phase 2; builds on the flow file created in US1 (T014 extends T008)
- **US3 (Phase 5)**: Depends on US1 (extends the runner and flow); T020 depends on US1's routing (T009)
- **Polish (Phase 6)**: Depends on all stories

### Within Each Story

- Pure helpers before effects
- Runner before flow
- Flow before pipeline routing and screen wiring

### Parallel Opportunities

- T005 touches a different file from T002/T003 (neither is marked `[P]` because T003 follows T002 in the same file and T004 imports it)
- T006 and T007 are `[P]` with each other (runner file vs core helper file); T007 runs after Phase 2 since it extends the same core helper file
- T012 is `[P]` with US1 tasks that touch other files; T013 follows T012 (same file)
- T021 is `[P]` with the other US tasks; T022 follows T021 because its test compares the README block with `/help`

---

## Parallel Example: User Story 1

```bash
# Together (different files):
Task: "T006 [P] [US1] Create src/cli/chat/userCommandRunner.ts …"
Task: "T007 [P] [US1] userCommandTranscriptText in src/core/agent/userCommands.ts …"

# Then in order:
Task: "T008 [US1] Create src/cli/chat/userCommandFlow.ts …"
Task: "T009 [US1] Route input in src/cli/chat/submitPipeline.ts …"
Task: "T010 [US1] Wire deps in screenDeps.ts and ChatScreen.tsx …"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1, then Phase 2
2. Phase 3 (T006–T011)
3. **STOP and VALIDATE**: `! ls -la` runs with no model call; budget test green

### Incremental Delivery

1. Setup + Foundational → classification and status rules ready
2. US1 → direct execution works → MVP
3. US2 → the model can read results; durable across resume
4. US3 → bounds, cancel, env cleaning, queued lines
5. Polish → help, README, module lists, full gates

---

## Notes

- `[P]` tasks touch different files with no dependency on incomplete tasks
- Every task that changes `src/` names the test file that must cover it
- `ChatScreen.tsx` must stay at or below 450 lines
- No new setting, no confirmation gate, no validation evidence for `!` runs
