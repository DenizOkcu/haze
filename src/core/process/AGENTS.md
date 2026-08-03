# src/core/process/AGENTS.md

Last updated: 2026-07-10 for the 0.9.0 release.

Bounded subprocess execution shared by `bash` and `grep`.

## Responsibilities

- `runBoundedProcess.ts` spawns a child process with independent stdout/stderr byte budgets, a timeout, an optional abort signal, and process-tree termination. An optional `onStdoutChunk` interceptor lets callers inspect chunks as they arrive and request early termination (grep's match-cap early stop is built on this; CR-004).
- `signalProcessTree` is the shared POSIX/Windows process-tree signaling helper used by bounded commands and LSP teardown.

## Contracts

- Collect stdout and stderr into bounded head buffers during the run; never let the full output become resident before capping. Report `retainedBytes`/`omittedBytes` truthfully.
- Preserve valid UTF-8 at truncation boundaries (flush the `StringDecoder` tail only when nothing was omitted from that stream).
- On POSIX, spawn owned commands `detached` and signal the process group (`-pid`), falling back to direct child signaling when the group is unavailable; escalate `SIGTERM` -> `SIGKILL` after `killGraceMs`. On Windows use `taskkill /pid <pid> /T /F` on the force phase.
- Resolve exactly once across `close`, `error`, timeout, and abort. After forced termination, use a short close fallback and destroy owned stdio streams so an escaped descendant retaining a pipe cannot hang the caller. Report `code`, `signal`, `timedOut`, `aborted`, `forced`, and `durationMs`.
- Do not spawn work when the abort signal is already aborted.

## Tests

- `tests/core/process/runBoundedProcess.test.ts`
