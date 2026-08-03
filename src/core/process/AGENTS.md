# src/core/process/AGENTS.md

Last updated: 2026-08-03 for the complete 0.10.0 release.

Bounded subprocess execution shared by `bash` and `grep`.

## Responsibilities

- `runBoundedProcess.ts` spawns a child process with independent stdout/stderr byte budgets, a timeout, an optional abort signal, and process-tree termination. An optional `onStdoutChunk` interceptor lets callers inspect chunks as they arrive and request early termination (grep's match-cap early stop is built on this; CR-004).
- `signalProcessTree` is the shared POSIX/Windows process-tree signaling helper used by bounded commands, registered background processes, and LSP teardown.
- `backgroundRegistry.ts` owns main-turn dev servers/watchers. It enforces the concurrency cap, keeps a byte-bounded rolling output window behind dynamic output handles, publishes live-count changes, and tears down every owned tree on session reset or process exit.

## Contracts

- Collect stdout and stderr into bounded head buffers during the run; never let the full output become resident before capping. Report `retainedBytes`/`omittedBytes` truthfully.
- Preserve valid UTF-8 at truncation boundaries (flush the `StringDecoder` tail only when nothing was omitted from that stream).
- On POSIX, spawn owned commands `detached` and signal the process group (`-pid`), falling back to direct child signaling when the group is unavailable; escalate `SIGTERM` -> `SIGKILL` after `killGraceMs`. On Windows use `taskkill /pid <pid> /T /F` on the force phase.
- Resolve exactly once across `close`, `error`, timeout, and abort. After forced termination, use a short close fallback and destroy owned stdio streams so an escaped descendant retaining a pipe cannot hang the caller. Report `code`, `signal`, `timedOut`, `aborted`, `forced`, and `durationMs`.
- Do not spawn work when the abort signal is already aborted.
- Background processes never survive haze exit and are unavailable to fleet workers. Turn abort does not kill an already-registered process; `/new`, explicit kill, SIGINT/SIGTERM, and normal app exit do.
- Keep rolling background output tail-bounded by `BACKGROUND_PROCESS_OUTPUT_BYTES`, with truthful total/retained/omitted byte counts.

## Tests

- `tests/core/process/runBoundedProcess.test.ts`
- `tests/core/process/backgroundRegistry.test.ts`
