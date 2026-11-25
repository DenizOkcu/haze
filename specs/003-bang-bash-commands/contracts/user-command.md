# Contract: `!` user commands

**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md) | **Data model**: [data-model.md](data-model.md)

All four surfaces below are public contract (input grammar, transcript, session content, help text).

## 1. Input grammar (interactive chat only)

Applies in `chat` mode at an idle prompt. In wizard/picker modes input goes to the wizard, as today.

| Input | Behaviour |
|-------|-----------|
| `!<command>` | Run `<command>` (leading/trailing whitespace trimmed). Space after `!` optional. |
| `  !<command>` | Same — leading whitespace is ignored. |
| `!` or `!` + whitespace only | Not executed. System message: `No command given after "!".` |
| `!!ls` | Runs the command `!ls` literally (usually "command not found", reported as a failure). |
| `\!<text>` | Sends `!<text>` to the model as a normal message; the backslash is removed. |
| Submitted while busy | Queued in order, like any message. The queue is drained when the running agent turn **or `!` command** finishes; a queued `!` line then runs as a command, anything else follows the normal pipeline. |

Lines not matching any row follow the existing pipeline unchanged. `/` commands are untouched.

## 2. Execution contract

| Property | Value |
|----------|-------|
| Shell | The same shell and invocation the model-run shell tool uses (`shellInvocation`). |
| Working directory | Workspace root. |
| Environment | Inherited, cleaned with `sanitizeProcessEnv` / `sanitizeProcessEnvExtra` when enabled. |
| stdin | Closed (`ignore`); a command that waits for input ends with its own result. |
| Time limit | 60 s by default (the runner applies it whenever no limit is passed); on expiry the process tree is terminated and partial output is kept. |
| Output capture | stdout and stderr each bounded by `SHELL_STREAM_BYTES`; reduced with the shared shell-output reducers, excerpt capped at `COMPACT_COMMAND_CHARS`, full text behind a handle. |
| Cancel | Esc while running. Process tree terminated, partial output kept. |
| Validation evidence | None. Never recorded as validation; never affects work state or completion. |
| Confirmation | None. |

## 3. Transcript row (display)

One `tool`-role message appended when the run finishes (control characters stripped at the sink, as for all output):

```
$ <command>
<stdout>
<stderr>
```
followed by a status line:

| Status | Status line |
|--------|-------------|
| `completed` | `exit 0 · <duration>` |
| `failed` | `exit <code> · <duration>` |
| `timed_out` | `stopped: time limit (60s) reached · partial output shown` |
| `cancelled` | `cancelled · partial output shown` |
| `error` | `could not run: <message>` |
| reduced output truncated | extra line: `output truncated — <omitted> chars omitted` (plus `full output: handle <handle>` when one exists) |

While running, the busy label reads `! <command head>` (first line, bounded).

## 4. Model-facing record (session content)

The exact format is defined in [data-model.md](data-model.md) → *UserCommandRecord*. Summary: one `user`-role string message inside `<haze_user_command>…</haze_user_command>`, stating that the user ran it, with command, status, exit code, duration and reduced output. It is:

- written to the conversation as soon as the run finishes and flushed to the session file;
- **not** sent to the model until the user submits a following message;
- folded into that following user message in the request copy;
- preserved verbatim on save, resume and fork.

## 5. Internal function contracts

Names are indicative; signatures are the contract.

```ts
// core/agent/userCommands.ts (pure)
export function parseUserInputLine(value: string): {kind: 'command'; command: string} | {kind: 'escaped'; value: string} | {kind: 'none'};
export function userCommandStatus(result: BoundedProcessResult): UserCommandStatus;
export function formatUserCommandRecord(run: UserCommandRun): string;          // envelope, escaped
export function foldUserCommandRecords(messages: ModelMessage[], turn: ModelMessage): ModelMessage[];
export function userCommandTranscriptText(run: UserCommandRun): string;        // row text + status line

// cli/chat/userCommandRunner.ts (effects)
export async function runUserCommand(input: {
  command: string; cwd: string; sanitizeEnv?: SanitizeEnvOptions; signal?: AbortSignal; timeoutMs?: number;
}): Promise<UserCommandRun>   // timeoutMs defaults to 60 000 when omitted
```

Invariants:
- `runUserCommand` never throws for process-level failures; it resolves with `status: 'error'`.
- `parseUserInputLine('!')` and `parseUserInputLine('!  ')` return `command: ''` — callers treat an empty command as "not a command".
- `foldUserCommandRecords` leaves a conversation with no trailing records byte-identical.
