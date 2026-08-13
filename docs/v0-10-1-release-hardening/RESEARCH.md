# v0.10.1 Release Hardening Research

## Executive summary

The codebase has strong safety primitives: bounded file/process/fetch output, process-tree teardown, session slimming, turn-wide counters, subagent quarantine, and explicit workspace boundaries. The release risk is concentrated in limits that are checked too late, work that scales quadratically or starts excessive subprocesses, and long-running operations without an absolute deadline.

The pre-release verdict was **no-go** until the release suite is deterministic and the `listFiles` ignore-checking design is fixed. The other P0 findings should be fixed before release or explicitly accepted as release risks.

## Validation evidence

During review:

- Typecheck passed.
- ESLint passed.
- Build passed.
- `npm audit --audit-level=high` reported zero vulnerabilities.
- Package dry run passed.
- One unrestricted full `npm test` run failed three timing-sensitive tests: two background-process tests and one `listFiles` pagination timeout.
- Re-running the two affected test files passed all 11 tests in 2.98 seconds.
- A prior full run with `--maxWorkers=4` passed all 1,327 tests.

Interpret this as resource-sensitive release-test behavior, not proof that the affected production paths are correct. The measured `listFiles` bottleneck is deterministic even though the timeout is load-dependent.

## Finding index

| ID | Priority | Finding | Release disposition |
|---|---|---|---|
| RH-001 | P0 | `listFiles` starts one Git subprocess per walked entry and cursor pages retraverse prior entries. | Must fix. |
| RH-002 | P0 | Default test parallelism produces release-gate timing failures. | Must fix after RH-001. |
| RH-003 | P0 | Main tool-call limits are checked after a parallel batch can already overshoot them. | Must fix. |
| RH-004 | P0 | An in-flight uncooperative tool can defer the idle timeout indefinitely. | Must fix or explicitly accept. |
| RH-005 | P0 | Context budgeting is pre-turn, fixed at 40K messages, and excludes full request overhead/model capacity. | Must fix or explicitly accept. |
| RH-006 | P0 | `stream-json` emits cumulative text and ignores stdout backpressure. | Must fix for long headless runs. |
| RH-007 | P1 | Transcript rendering repeatedly lexes historical Markdown. | Follow-up acceptable. |
| RH-008 | P1 | Session persistence appends repeated full snapshots and resume scans the full JSONL. | Follow-up acceptable with tracking. |
| RH-009 | P1 | LSP server startup/indexing repeats for every operation. | Follow-up acceptable. |
| RH-010 | P2 | A blocked mutation at the subagent queue head leaves read-only capacity idle. | Follow-up acceptable. |
| RH-011 | P1 | Release metadata synchronization is manual and unverified. | Fix before the next version bump. |

---

## RH-001 — `listFiles` N+1 Git subprocesses and cursor retraversal

### Current behavior

- `src/llm/hazeTools.ts` calls `walkDir` with an async filter.
- The filter invokes `isGitIgnored(entry.absolutePath)` for every entry.
- `src/llm/tools/fileToolShared.ts:isGitIgnored` starts `git check-ignore -q` through `execFile` for each invocation.
- `src/utils/fs.ts:walkDir` starts at the root on every page and only starts collecting after it encounters the cursor. Filters still run before the cursor is reached.

### Measured impact

On the reviewed repository:

- Recursive `src/` listing, about 210 entries: approximately 11.4 seconds.
- First 50-entry page: approximately 2.9 seconds.
- Second 50-entry page: approximately 5.4 seconds.

Later pages do more work because they rewalk and recheck entries preceding the cursor. Repository discovery becomes a major latency cost in agentic tasks.

### Recommended direction

Introduce a batch ignore API, preferably backed by one `git check-ignore --stdin -z` call for a candidate set. Preserve fail-open behavior when the workspace is not a Git repository or Git fails. Keep single-path `assertNotIgnored` behavior correct, but do not route directory walks through a per-entry subprocess.

Separate traversal from async filtering so pagination can stop after enough accepted entries. A cursor should represent deterministic traversal position and should not require expensive filtering of all prior entries. Preserve lexical order, `.git`/`node_modules` skipping, recursive pruning of ignored directories, and current cursor compatibility where practical.

### Required tests

- Batch ignore classification for ignored, unignored, nested, spaced, and non-repository paths.
- Assert a bounded number of Git invocations for hundreds of entries; do not rely only on wall-clock timing.
- First and later pages return stable, non-overlapping entries.
- Later page work is bounded rather than proportional to all prior pages.
- Existing ignored-directory pruning and `includeIgnored` semantics remain intact.

Likely files: `src/llm/hazeTools.ts`, `src/llm/tools/fileToolShared.ts`, `src/utils/fs.ts`, `tests/hazeTools/listFiles.test.ts`, `tests/utils/fs.test.ts`, and possibly file-mention suggestion tests.

---

## RH-002 — Default test parallelism is not a deterministic release gate

### Current behavior

`package.json` defines `npm test` as unrestricted `vitest run`; CI uses the same command across Ubuntu, Windows, and macOS on Node 22 and 24. Under review-machine load, process-readiness and pagination tests exceeded their deadlines. Targeted reruns passed.

### Recommended direction

First remove RH-001's subprocess storm. Then run the complete suite repeatedly using the exact package command. If process tests remain flaky, replace fixed short sleeps/deadlines with observable readiness and cleanup signals. Configure an explicit Vitest worker ceiling only if evidence shows the suite still overcommits resources; keep it in project configuration or the canonical script so local and CI behavior agree.

Do not merely increase the `listFiles` timeout while retaining the N+1 algorithm.

### Required tests/evidence

- At least three consecutive `npm test` runs on the implementation machine.
- Targeted background registry tests under concurrent suite load.
- CI matrix remains unchanged unless there is a documented reason to alter it.

Likely files: `package.json`, optional `vitest.config.ts`, `tests/core/process/backgroundRegistry.test.ts`, and `tests/hazeTools/listFiles.test.ts`.

---

## RH-003 — Parallel batches can overshoot main tool budgets

### Current behavior

`src/cli/commands/streaming.ts:prepareStep` checks turn and recovery-slice counters before a model step. `onStepEnd` increments `turnState.toolCallsUsed` only after the step's tool calls have executed. If the model emits a batch larger than the remaining allowance, every call can execute.

The subagent path already contains a suitable pattern: `src/core/subagent/subagentRunner.ts:withToolExecutionBudget` wraps each tool's `execute` function and atomically checks/increments at the actual execution boundary.

### Recommended direction

Extract the execution-boundary budget wrapper into shared core agent code. Apply it to the main tool set after rescue-tool restriction and before constructing `ToolLoopAgent`. It must enforce both the remaining turn-wide allowance and the current recovery slice allowance. Blocked calls should return a structured bounded failure, should not invoke the underlying tool, and should drive a final synthesis rather than repeated retries.

Define counter semantics clearly: count started underlying executions, not merely model-emitted calls. Reconcile `onStepEnd` accounting so blocked calls do not double count or make recovery calculations inconsistent.

### Required tests

- A single parallel batch larger than the remaining main-turn allowance executes only the remaining number.
- A recovery slice with two calls remaining blocks the third concurrent call.
- Mutating tools beyond the limit do not run.
- Blocked results produce bounded diagnostics and the next step is text-only.
- Provider retry/recovery slices cannot reset the shared limit.

Likely files: new or existing shared code under `src/core/agent/`, `src/core/subagent/subagentRunner.ts`, `src/cli/commands/streaming.ts`, `tests/cli/commands/streaming.test.ts`, and core budget tests.

---

## RH-004 — In-flight tools can keep a turn alive forever

### Current behavior

`src/cli/commands/streaming/idleTimer.ts` intentionally rearms while any tool is in flight and documents that there is no upper bound. Many built-ins have local deadlines, but tools from MCP are merged into the toolset without an execution timeout. Headless options do not expose an absolute turn timeout.

### Recommended direction

Use layered deadlines:

1. Absolute turn deadline, with a safe default and an explicit headless CLI override.
2. Per-tool execution deadline wrapper, with tool-specific overrides for legitimate long operations.
3. MCP call timeout wrapping discovered tools, distinct from existing MCP discovery/close timeouts.
4. Existing idle timeout retained for stalled model streams while no tool is active.

Propagate one abort signal where supported. Timeout wrappers must settle promptly even if the underlying operation ignores cancellation; quarantine late settlements and avoid unhandled rejections. Emit diagnostics that identify whether the timeout occurred in model streaming, tool execution, queueing, or teardown.

### Required tests

- A never-settling MCP tool times out and the turn ends.
- A busy tool cannot defer the absolute turn deadline.
- A normally completing long tool is not killed before its configured deadline.
- Late resolution/rejection after timeout causes no state mutation or unhandled rejection.
- Background process teardown remains bounded.
- Headless `--timeout` parsing and exit status are documented and tested.

Likely files: `src/core/agent/budgets.ts`, a shared deadline utility under `src/core/`, `src/llm/mcp.ts`, `src/cli/commands/streaming.ts`, `src/cli/commands/streaming/idleTimer.ts`, `src/cli/index.ts`, `src/cli/commands/runCommand.ts`, and related MCP/idle/headless tests.

---

## RH-005 — Context budgeting ignores full request cost and model capacity

### Current behavior

- `ACTIVE_CONTEXT_TOKEN_BUDGET` is fixed at 40,000.
- `runAgentTurn` compacts messages once before constructing the agent.
- The cap is applied to messages before accounting for system instructions, tool schemas, output reserve, and provider/model context size.
- The baseline context report estimated about 5,728 logical input tokens, including roughly 3,292 system tokens, before a long conversation.
- The configured output allowance is 16,384 tokens.
- No compaction is performed between successful steps in a long tool loop.
- Manual/overflow compaction in `src/cli/chat/sessionLifecycle.ts` also uses a hard-coded 40,000 target.

A nominal 40K message budget can therefore require roughly 62K total context. Smaller local models may overflow immediately or repeatedly. A failure before `onEnd` can also leave recovery using stale pre-attempt history unless completed-step response messages are retained.

### Recommended direction

Create one request-budget calculation used by normal turns, retries, and manual compaction:

`message budget = context window - system estimate - tool schema estimate - output reserve - safety margin`

Allow context-window and output-limit metadata for configured models/providers without silently guessing a provider's capacity. Choose a conservative documented fallback when metadata is absent. Preserve unknown settings fields and validate malformed values loudly.

At each `prepareStep`, estimate accumulated request size and compact old successful tool history before the next provider call. Preserve tool-call/tool-result protocol validity and current work-state summaries. On overflow, retain the latest completed step evidence and retry with a progressively smaller target rather than the same 40K value.

### Required tests

- 16K, 32K, and large-context model configurations yield safe message budgets.
- System/tool growth reduces the message allowance.
- Output reserve never makes the request exceed the configured window.
- Multi-step accumulation triggers compaction before overflow.
- Completed tool evidence survives an overflow retry.
- Repeated overflow lowers the target and terminates safely.
- Settings round-trip preserves unrelated and unknown fields.

Likely files: `src/core/agent/contextBudget.ts`, `src/core/agent/requestAssembly.ts`, `src/core/agent/compaction.ts`, `src/core/agent/budgets.ts`, `src/cli/commands/streaming.ts`, `src/cli/chat/sessionLifecycle.ts`, `src/config/settings.ts`, `src/config/providers.ts`, provider wizard code if metadata is user-configurable, and related tests.

---

## RH-006 — Cumulative stream events create quadratic output

### Current behavior

`message_update` carries the complete accumulated assistant text. `runCommand.ts` serializes every update in `stream-json` mode with synchronous `process.stdout.write` calls and does not wait for drain. For long responses, total serialized bytes grow quadratically with response length.

Interactive session recording calls `JSON.stringify(event)` before persistence later drops `message_update`, so it still pays serialization and queueing overhead for events that are intentionally non-durable.

A 16K-token response delivered in small increments can produce hundreds of megabytes of cumulative NDJSON even when the final answer is only tens of kilobytes.

### Recommended direction

Change the external stream contract to delta updates, or emit throttled snapshots with an explicit sequence/offset contract. Delta events are preferred. Keep `message_end` authoritative and complete. Introduce an async NDJSON sink that serializes writes in order and awaits `drain` when `write()` returns false. Do not call `JSON.stringify` for `message_update` in `SessionRecorder` because these events are never persisted.

Treat the event-shape change as a public contract: update README/static docs/changelog and consider a compatibility field or documented migration if consumers rely on cumulative `text`.

### Required tests

- Total update payload is O(final text size), not O(n²).
- Deltas reconstruct the exact final `message_end` text.
- Multibyte Unicode and segment resets are correct.
- NDJSON writes remain ordered across simulated backpressure.
- Final result waits for pending stream writes.
- Session recorder does not stringify or enqueue `message_update`.

Likely files: `src/core/agent/events.ts`, `src/cli/commands/streaming.ts`, `src/cli/commands/runCommand.ts`, `src/cli/chat/sessionRecorder.ts`, streaming/headless/session tests, README, changelog, and static command docs.

---

## RH-007 — Historical Markdown is repeatedly lexed

`src/cli/commands/chat.tsx` rebuilds `[...visible, ...activeLiveMessages]` and calls `partitionDisplayMessages` on every render. `partitionDisplayMessages` invokes `markdownRootChunks`, which calls `marked.lexer` for assistant content. A synthetic 1,000-message, 1.76 MB transcript took about 30.5 ms for partitioning alone, before Ink rendering.

Recommended follow-up: maintain an incremental committed static prefix, cache root chunks by message ID/content signature, and restrict lexing to new or changed assistant messages. Add a benchmark-style regression test with a generous deterministic work-count assertion rather than a fragile machine-specific deadline.

Likely files: `src/cli/commands/chat.tsx`, `src/cli/chat/messages.tsx`, `src/ui/components/MarkdownText.tsx`, and `tests/cli/messages.test.tsx`.

---

## RH-008 — Session snapshots cause disk and restore growth

`setConversation` can record repeated complete `conversation_snapshot` entries. Session files are append-only. Restore scans the entire JSONL and retains only the latest snapshots. Slimming bounds large values but does not eliminate repeated full-history snapshots. Private-file helpers also reopen/chmod on appends.

Recommended follow-up: coalesce adjacent snapshots, write one durable snapshot at an intentional turn/attempt checkpoint, and periodically compact long session files atomically. Maintain crash recovery and malformed-line reporting. Add long-session tests that assert file growth and restore work remain near-linear.

Likely files: `src/cli/chat/sessionRecorder.ts`, `src/cli/commands/chat.tsx`, `src/core/session/sessionStore.ts`, `src/core/session/sessionSlimming.ts`, `src/config/privateStorage.ts`, and session tests.

---

## RH-009 — LSP lifecycle repeats expensive startup

`src/llm/lsp.ts:withLsp` starts, initializes, opens a document, and closes a language server for every document-symbol, definition, or references invocation. Project indexing is often more expensive than the operation itself.

Recommended follow-up: create a per-turn/session pool keyed by server configuration, lazily initialize each client, track opened document versions, and close all clients during turn teardown. Preserve request/frame/document bounds and process cleanup. Test reuse, invalidation, crash recovery, concurrent requests, and teardown.

---

## RH-010 — Subagent queue head can leave capacity idle

`SubagentCoordinator.admit` stops when the queue head is a mutation mode and another mutation is running. Read-only validation work behind it cannot use available slots. Mutation workers also hold the mutation classification for their full run, not only while mutating.

Recommended follow-up: permit a bounded read-only bypass behind one blocked mutation while preserving mutation priority and starvation protection. A deeper lease-at-first-mutation change is higher risk and should be separate. Add deterministic scheduler tests proving ordering, bounded bypass, and no overlapping mutations.

---

## RH-011 — Release version metadata has no consistency check

The corrected 0.10.1 release required manual updates across package metadata, README, changelog, security policy, AGENTS stamps, and static docs. No command verifies consistency.

Recommended direction: add a read-only `release:verify` script that derives the package version and validates lockfile root version, README/changelog release headings, supported security series, and static docs version stamps. It should report every mismatch and return non-zero. Add it to `prepublishOnly` and CI without rewriting files.

Likely files: a new script under `scripts/`, `package.json`, `.github/workflows/ci.yml`, script tests or fixtures, and release documentation.

## Cross-cutting implementation cautions

- Do not weaken fail-open Git behavior for non-repositories while optimizing ignore checks.
- Timeout promises do not stop underlying work by themselves; quarantine late completion and propagate abort signals.
- Tool-call accounting must have one source of truth after adding execution-boundary checks.
- Compaction must preserve valid assistant-tool/tool-result relationships.
- Stream event changes are public API changes even if TypeScript types are internal.
- Performance tests should primarily assert operation counts, bounded payload size, and asymptotic behavior; use wall-clock thresholds only as secondary smoke tests.
