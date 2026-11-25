# Quickstart: validating `!` user commands

**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md) | **Contract**: [contracts/user-command.md](contracts/user-command.md)

## Prerequisites

```bash
npm install
```

## Automated checks

```bash
npm run typecheck
npx vitest run tests/core/userCommands.test.ts tests/cli/chat/userCommandRunner.test.ts tests/cli/chat/chatScreenBudget.test.ts
npm test
npm run lint
npm run build
```

`tests/core/userCommands.test.ts` and `tests/cli/chat/userCommandRunner.test.ts` are new files created by the implementation.

### Unit scenarios (pure helpers)

| # | Given | Expect |
|---|-------|--------|
| U1 | `parseUserInputLine('! ls -la')` | `{kind: 'command', command: 'ls -la'}` |
| U2 | `parseUserInputLine('!echo done')` | `command: 'echo done'` |
| U3 | `parseUserInputLine('  ! ls')` | `command: 'ls'` |
| U4 | `parseUserInputLine('!')`, `('!  ')` | `command: ''` |
| U5 | `parseUserInputLine('!!ls')` | `command: '!ls'` |
| U6 | `parseUserInputLine('\\! hello')` | `{kind: 'escaped', value: '! hello'}` |
| U7 | `parseUserInputLine('hello')`, `('/help')` | `{kind: 'none'}` |
| U8 | status derivation for each of: `error` set, `aborted`, `timedOut`, `code 0`, `code 1` | `error`, `cancelled`, `timed_out`, `completed`, `failed` — in that precedence |
| U9 | output containing `</haze_user_command>` and `</HAZE_USER_COMMAND >` | closers escaped in the record |
| U10 | record with output over the excerpt cap | truncation stated; text within cap |
| U11 | `[assistant, record, record]` + new user turn | one user message: record, record, turn text |
| U12 | `[assistant]` + new user turn | returned unchanged |

### Runner scenarios (real subprocess, temp dir)

| # | Command | Expect |
|---|---------|--------|
| R1 | `echo out; echo err 1>&2` | both texts present, `completed`, `exitCode 0` |
| R2 | `exit 3` | `failed`, `exitCode 3` |
| R3 | `definitely-not-a-command-xyz` | `failed`, stderr kept |
| R4 | a command sleeping past a 200 ms limit | `timed_out`, partial output kept, resolves within limit + 1 s |
| R5 | a command reading stdin (`cat`) | settles by itself, no hang |
| R6 | abort signal fired mid-run | `cancelled`, resolves within 1 s |
| R7 | output of 50 000 lines | record text bounded; truncation stated |

## Manual end-to-end (interactive terminal)

Start with `npm run dev`, then:

1. `! ls -la` → output appears immediately (within about one second; this is the SC-002 check); no model request is made (no assistant reply).
1b. `! sleep 30`, and while it runs type `! echo queued` → the second command runs right after the first ends or is cancelled, and is not sent to the model as text.

2. `!` → "No command given" message; nothing runs.
3. `!false` → shown as `exit 1`, not as success.
4. `! sleep 120` → Esc → "cancelled · partial output shown" within about a second; no `sleep` left behind (`pgrep -f "sleep 120"` is empty).
5. `! sleep 120` → after 60 s → "time limit reached".
6. `! seq 1 100000` → bounded excerpt with a truncation line.
7. `! ls -la`, then type `what files are here?` → the model answers from the recorded output (no `shell` tool call in the transcript).
8. `/exit`, then `haze --continue` (or resume the session), ask about the `! ls -la` output → the model still knows it.
9. `\! is this sent literally?` → reaches the model as `! is this sent literally?`.
10. Type `! echo a` while a model turn is running → it runs after the turn ends, in order, and is not sent to the model as text.
11. `/help` lists the `!` shortcut; README mentions it.

## Evidence that the model was not called for step 1

Run with `--debug` and confirm no request log entry is written for the `!` submission, or watch the token usage in the status bar: it does not change.
