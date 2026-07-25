# src/core/process/AGENTS.md

Last updated: 2026-07-10 for the security/correctness remediation (unreleased).

Bounded subprocess execution shared by `bash` and `grep`.

## Responsibilities

- `runBoundedProcess.ts` spawns a child process with independent stdout/stderr byte budgets, a timeout, an optional abort signal, and process-tree termination.

## Contracts

- Collect stdout and stderr into bounded head buffers during the run; never let the full output become resident before capping. Report `retainedBytes`/`omittedBytes` truthfully.
- Preserve valid UTF-8 at truncation boundaries (flush the `StringDecoder` tail only when nothing was omitted from that stream).
- On POSIX, spawn `detached` and signal the process group (`-pid`); escalate `SIGTERM` -> `SIGKILL` after `killGraceMs`. On Windows use `taskkill /pid <pid> /T /F` on the force phase.
- Resolve exactly once across `close`, `error`, timeout, and abort. Report `code`, `signal`, `timedOut`, `aborted`, `forced`, and `durationMs`.
- Do not spawn work when the abort signal is already aborted.

## Tests

- `tests/core/process/runBoundedProcess.test.ts`
