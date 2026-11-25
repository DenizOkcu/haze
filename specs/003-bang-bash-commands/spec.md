# Feature Specification: `!` Bash Command Execution

**Feature Branch**: `003-bang-bash-commands`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "add bash commands execution in haze. description: if the user input starts with a ! the rest of the input is treated as a raw command and the return is given back to the llm. example: '! ls -la' executes 'ls -la' and returns the output to the llm"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a shell command directly from the prompt (Priority: P1)

As a haze user, I want to type a line beginning with `!` followed by a shell command, have it executed immediately without the model deciding whether or how to run it, and see its output in the conversation, so that I can check the state of my workspace or run a known command without describing the task in natural language.

**Why this priority**: This is the entire feature. Without immediate, literal execution of the typed command nothing else matters.

**Independent Test**: Type `! ls -la` at an idle prompt. The command runs as typed and its output appears in the conversation. This alone is a usable MVP.

**Acceptance Scenarios**:

1. **Given** the prompt is idle, **When** the user submits `! ls -la`, **Then** the command `ls -la` runs in the current workspace with the user's own environment and shell, and its combined output (both standard output and standard error) is shown in the conversation.
2. **Given** the prompt is idle, **When** the user submits `!echo done`, **Then** the command `echo done` runs (the space after `!` is optional).
3. **Given** a command that prints to both standard output and standard error, **When** it finishes, **Then** both streams are shown (standard output first, then standard error; their interleaving order is not preserved), and the exit status is distinguishable between success and failure.
4. **Given** a command exits with a non-zero status, **When** it finishes, **Then** the failure and its status are reported truthfully; the run is never shown as successful.

---

### User Story 2 - The model receives the command result (Priority: P2)

As a haze user, I want the output of my `!` command to be handed to the model as the result of a user-run command, so that I can follow up in the same conversation ("why did that fail?") and the model can read, reason about, and act on what the command produced.

**Why this priority**: It turns direct execution into a shared context between user and model, but the feature is useful on its own without it.

**Independent Test**: Submit `! ls -la`, then ask "what files are in this directory?" in the next message. The model answers from the recorded command output without re-running the command.

**Acceptance Scenarios**:

1. **Given** a completed `!` command, **When** the user sends a follow-up message, **Then** the exact command text and its full output are available to the model as conversation context, labelled as a command the user ran.
2. **Given** a completed `!` command, **When** the session is saved and later resumed or forked, **Then** the command and its output are still part of the conversation history.
3. **Given** a `!` command that failed, **When** the user asks about it, **Then** the model can see the failure status and error output.

---

### User Story 3 - Keep control over long, large, and unsafe commands (Priority: P3)

As a haze user, I want long-running, verbose, interactive, or environment-unsafe `!` commands to behave predictably, so that a direct command cannot hang the app, flood the conversation, or leak secrets.

**Why this priority**: These are protections around the core behaviour. They matter, but the feature works without them for ordinary short commands.

**Independent Test**: Submit a command that never exits, and one that prints tens of thousands of lines. The first is stopped with a clear message; the second is shortened with the full output still retrievable.

**Acceptance Scenarios**:

1. **Given** a `!` command that runs longer than the normal command time limit, **When** the limit is reached, **Then** the command is stopped, its partial output is kept, and the result says it was stopped for exceeding the time limit.
2. **Given** a `!` command that produces more output than the conversation can show, **When** it finishes, **Then** a bounded excerpt is shown and marked as truncated, with the complete output still retrievable.
3. **Given** a `!` command that waits for keyboard input, **When** it runs, **Then** it receives no interactive input and ends with a clear result instead of hanging the app.
4. **Given** the secret-removal setting is enabled, **When** a `!` command runs, **Then** its process environment is cleaned the same way as for model-run commands.
5. **Given** a `!` command is still running, **When** the user presses the cancel key, **When** the command is stopped, **Then** the partial output is kept and the result reports the cancellation.

---

### Edge Cases

- A line containing only `!` (no command) is not executed; the user is told a command is required.
- `!` followed only by whitespace is treated the same as an empty command.
- Multi-line pasted input starting with `!` is treated as one command submission.
- Lines starting with `!!` are not shell history expansion; the command after the first `!` is run literally (`!!ls` runs `!ls`), which will normally fail with "command not found" and be reported as such.
- A line whose first non-space character is `!` (e.g. `  ! ls`) is treated as a command.
- Escaping: a user who wants to send a literal message beginning with `!` to the model can prefix it with a backslash (`\! text`); the backslash is removed and the rest is sent as a normal message.
- A line starting with `/` is still a slash command; `!` never conflicts with it.
- A command not found by the shell is reported as a failure with the shell's message, not as a crash.
- The user submits a `!` line while a turn or another command is already running: it is queued like a normal message rather than started concurrently.
- Headless (non-interactive) runs: a `!` line is out of scope for this feature (see Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a submitted user line's first non-whitespace character is `!`, the system MUST treat the remainder (after the `!`, with surrounding whitespace trimmed) as a shell command and MUST execute it directly, without sending it to the model first.
- **FR-002**: A line that is only `!` or `!` plus whitespace MUST NOT be executed and MUST return a clear "no command given" message.
- **FR-003**: The command MUST run in the user's current workspace with the user's own environment, using the same shell the app uses for model-run commands.
- **FR-004**: The command MUST run non-interactively: it receives no keyboard input and MUST be ended with a clear result if it waits for input.
- **FR-005**: The system MUST display the command and its output (standard output and standard error, each kept in its own order; interleaving between the two is not preserved) in the conversation, with success or failure truthfully reflecting the exit status.
- **FR-006**: The system MUST apply the same output limits as model-run commands: oversized output is reduced to a bounded excerpt, marked as truncated, with the full output retrievable through a stored-output handle named in the model-facing record.
- **FR-007**: The system MUST apply the existing command time limit to `!` commands; on expiry it MUST stop the command, keep partial output, and report the stop and its reason.
- **FR-008**: The user MUST be able to cancel a running `!` command; cancellation MUST stop the command, keep partial output, and report the cancellation.
- **FR-009**: On completion (success, failure, timeout, or cancellation), the system MUST record the command and its output in the conversation as a user-run command, available to the model for subsequent turns and preserved on save, resume, and fork.
- **FR-010**: Submitting a `!` command MUST NOT by itself trigger a model turn. The model sees the result only when the user sends a following message.
- **FR-011**: Secret protection settings that apply to model-run commands (environment cleaning, secret redaction in saved sessions and debug logs) MUST apply identically to `!` commands.
- **FR-012**: File, Git-internals, and network protections that block the app's file tools MUST NOT restrict `!` commands; the user runs with their own privileges, as with any terminal.
- **FR-013**: A line beginning with `\!` MUST be delivered to the model as a normal message with the leading backslash removed.
- **FR-014**: The output of a `!` command MUST be treated as untrusted content when shown to the model: control characters MUST be stripped for display, and the model MUST be told the output came from a command the user ran, not from the user directly.
- **FR-015**: A `!` command MUST NOT count as validation evidence for completion purposes, since the user, not the agent, ran it.
- **FR-016**: An internal failure while starting or running a `!` command MUST be reported as a failed result with a reason; it MUST NOT crash the app.

### Key Entities

- **User Command**: A shell command the user ran directly via `!`. Attributes: the command text as typed after `!`, start and end times, exit status, combined output (possibly reduced with a handle to the full output), and an end reason (completed, failed, timed out, cancelled).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A submitted `!` command starts executing without a model request being made, 100% of the time.
- **SC-002**: For a command that finishes in under one second, the user sees its output within one second of submission.
- **SC-003**: In 100% of test cases, the displayed result (success vs. failure, exit status, timeout, cancellation) matches what happened.
- **SC-004**: In 100% of test cases, the model can answer a follow-up question using the recorded output of a previous `!` command without re-running it, including after resume and fork.
- **SC-005**: No `!` command, however long-running, verbose, or interactive, can hang the app beyond the existing command time limit plus a short grace period.
- **SC-006**: Existing behaviour is unchanged: 100% of existing tests still pass, slash commands behave as before, and messages not starting with `!` reach the model unchanged.

## Assumptions

- `!` handling applies to the interactive terminal UI only; headless/non-interactive runs do not accept `!` lines in this feature.
- The shell and environment used are exactly those already used for model-run commands; no new configuration is introduced.
- Time limit, output limits, cancellation, and environment-cleaning behaviour reuse the existing settings and defaults; no `!`-specific settings are added.
- The command runs in the foreground of the current session and is visible in the transcript like other tool output; it does not start as a managed background process.
- There is no persistent `!` history or `!!` recall in this feature.
- The user is an expert who intends the command to run as typed; no confirmation prompt is shown before execution.
