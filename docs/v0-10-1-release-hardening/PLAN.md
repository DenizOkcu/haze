# v0.10.1 Release Hardening Implementation Plan

## Goal

Resolve the release blockers identified in `RESEARCH.md`, add deterministic regression coverage, and isolate larger scalability work so each change remains reviewable and reversible.

## Non-goals

- Rewriting the agent loop or replacing the AI SDK.
- Changing workspace security policy, ignore semantics, or output-retention policy.
- Editing generated `dist/` files.
- Combining every P1/P2 optimization into one release-blocking patch.
- Hiding test instability by only increasing timeouts.

## Agent working contract

1. Read root `AGENTS.md` and every nested `AGENTS.md` in a touched subtree.
2. Check `git status --short` before each phase and preserve unrelated changes.
3. Implement one task group at a time with tests.
4. After each task group, run targeted tests, typecheck, and lint for touched source.
5. Update `STATUS.md` and create/update `IMPLEMENTATION.md` with exact evidence.
6. Do not commit unless explicitly requested.

## Phase 1 — Required release hardening

### Task 1.1 — Replace per-entry Git ignore subprocesses (RH-001)

**Implementation steps**

1. Add a batch ignore-classification primitive in `src/llm/tools/fileToolShared.ts` or a focused new module.
   - Accept workspace-relative or absolute candidate paths.
   - Use one bounded Git process per batch, not per path.
   - Use NUL-delimited input/output to preserve spaces and unusual names.
   - Distinguish expected exit 1 from operational errors internally, while preserving current public fail-open behavior.
2. Refactor `listFiles` to gather/traverse candidates in bounded chunks, classify them in batches, prune ignored directories, and stop after `maxEntries + 1` accepted entries.
3. Refactor cursor traversal so a later page does not rerun expensive ignore work for all entries preceding the cursor. If the cursor format must change, support old lexical cursors for one release or document the break.
4. Reuse batching in file-mention suggestions where it improves behavior without expanding scope.
5. Add operation-count tests by injecting/spying on the Git runner. Add paging correctness tests.

**Expected files**

- `src/llm/hazeTools.ts`
- `src/llm/tools/fileToolShared.ts` or a new ignore helper
- `src/utils/fs.ts`
- `src/cli/chat/fileMentionSuggestions.ts` if reused there
- `tests/hazeTools/listFiles.test.ts`
- `tests/utils/fs.test.ts`
- `tests/cli/chat/fileMentionSuggestions.test.ts` if applicable

**Acceptance**

- Hundreds of entries require O(1) or O(number of bounded batches) Git subprocesses.
- Page 2 does not perform Git checks proportional to all page-1 entries.
- Ordering, cursor behavior, ignore pruning, `includeIgnored`, `.git`, and `node_modules` contracts pass.
- The existing pagination timeout test passes comfortably under full-suite load.

### Task 1.2 — Stabilize the canonical test command (RH-002)

**Implementation steps**

1. Run the full suite after Task 1.1 before changing worker settings.
2. If background-process tests still fail, replace polling/sleep assumptions with process output, state transition, or teardown completion signals.
3. If unrestricted Vitest concurrency still causes host resource oversubscription, define an explicit worker cap in canonical configuration. Document why the chosen value works across the six CI matrix jobs.
4. Run the exact `npm test` command at least three consecutive times.

**Expected files**

- `tests/core/process/backgroundRegistry.test.ts`
- `package.json` and/or `vitest.config.ts` only if a worker cap remains necessary

**Acceptance**

- Three consecutive exact `npm test` runs pass.
- No production timeout is increased merely to make tests pass.

### Task 1.3 — Enforce main tool budgets at execution (RH-003)

**Implementation steps**

1. Extract `withToolExecutionBudget` from subagent code into shared core agent code.
2. Define a shared state/result contract for allowed, blocked, started, and exhausted executions.
3. Wrap main tools with a limit equal to the minimum remaining turn and recovery-slice allowance.
4. Ensure check-and-increment happens synchronously immediately before underlying `execute`.
5. Reconcile `onStepEnd` and recovery accounting with execution-start counts.
6. Force synthesis after budget blocking; prevent malformed/repeated-call recovery from bypassing exhaustion.

**Expected files**

- New shared module under `src/core/agent/`
- `src/core/subagent/subagentRunner.ts`
- `src/cli/commands/streaming.ts`
- `src/core/agent/completionController.ts` or `turnBudget.ts` if semantics change
- `tests/cli/commands/streaming.test.ts`
- `tests/core/subagent/subagentRunner.test.ts`
- Core budget tests

**Acceptance**

- Underlying executions never exceed main or slice limits, even within one parallel batch.
- Existing subagent behavior remains green.
- Blocked mutations have no side effect.

### Task 1.4 — Add layered absolute and per-tool deadlines (RH-004)

**Implementation steps**

1. Add a reusable abort-aware deadline primitive with cleanup and late-settlement quarantine.
2. Add an absolute main-turn deadline distinct from the idle timer.
3. Add a default tool-execution deadline wrapper; retain explicit longer limits for subagents/background-aware operations where needed.
4. Wrap discovered MCP tool `execute` functions with the configured/default deadline.
5. Add a headless `--timeout` option with validated units/range; thread it to `runAgentTurn` without adding provider/model environment variables.
6. Emit bounded phase-specific timeout errors/events and ensure all clients/processes still close.

**Expected files**

- `src/core/agent/budgets.ts`
- New shared deadline module under `src/core/`
- `src/cli/commands/streaming.ts`
- `src/cli/commands/streaming/idleTimer.ts`
- `src/llm/mcp.ts`
- `src/cli/index.ts`
- `src/cli/commands/runCommand.ts`
- MCP, idle timer, streaming, and headless tests
- README/static command docs/changelog for the option

**Acceptance**

- A never-settling tool cannot keep the turn alive beyond its deadline.
- A busy tool cannot defeat the absolute turn deadline.
- Timeout cleanup has no unhandled rejections or late state changes.

### Task 1.5 — Make context limits full-request and model-aware (RH-005)

**Implementation steps**

1. Define validated context-window/output-limit configuration associated with the selected model or provider. Prefer a minimally disruptive schema and preserve unknown fields.
2. Extend request-budget helpers to calculate available message tokens from full input breakdown, output reserve, and safety margin.
3. Replace hard-coded 40K compaction targets in normal and manual/overflow paths with the computed target.
4. Re-evaluate accumulated messages in `prepareStep`; compact old tool history before the next provider request when needed.
5. Persist/use latest completed-step response messages for overflow recovery.
6. Make repeated overflow progressively reduce the target and terminate with a precise diagnostic when no safe request can be formed.
7. Expose budget details in debug/context reporting without leaking credentials.

**Expected files**

- `src/config/settings.ts`
- `src/config/providers.ts`
- Provider wizard files if configuration is interactive
- `src/core/agent/contextBudget.ts`
- `src/core/agent/requestAssembly.ts`
- `src/core/agent/compaction.ts`
- `src/cli/commands/streaming.ts`
- `src/cli/chat/sessionLifecycle.ts`
- `src/cli/contextReport.ts`
- Config, compaction, context-budget, streaming, and overflow tests
- User documentation if settings are user-facing

**Acceptance**

- The assembled request plus output reserve stays under configured capacity.
- Small local contexts receive a safe budget instead of the fixed 40K target.
- Long multi-step turns compact before provider overflow.
- Overflow retries retain completed evidence and cannot loop at an unchanged target.

### Task 1.6 — Make `stream-json` linear and backpressure-aware (RH-006)

**Implementation steps**

1. Choose and document a delta event shape. Recommended: `message_update` carries `delta` and a monotonic sequence or UTF-16 offset; `message_end.text` remains complete and authoritative.
2. Emit only newly arrived text from streaming code. Handle assistant segment resets and hidden fragments.
3. Replace fire-and-forget NDJSON writes with an ordered async sink that waits for `drain` and can be flushed before the final result/exit.
4. Skip `message_update` immediately in `SessionRecorder.recordEvent`, before serialization and queueing.
5. Update public docs/changelog and integration tests.

**Expected files**

- `src/core/agent/events.ts`
- `src/cli/commands/streaming.ts`
- `src/cli/commands/runCommand.ts`
- `src/cli/chat/sessionRecorder.ts`
- `tests/cli/commands/runHeadless.integration.test.ts`
- `tests/cli/commands/streaming.test.ts`
- `tests/cli/chat/sessionRecorder.test.ts`
- README, changelog, and static command docs

**Acceptance**

- Aggregate update payload is bounded by a small constant multiple of final text size.
- Deltas reconstruct exact final text.
- Simulated stdout backpressure preserves ordering and delays the terminal result until all events flush.
- Streaming updates never enter the persistence writer.

## Phase 1 review gate

Before proceeding, run an independent review focused on:

- Ignore semantics and path encoding.
- Atomic execution-budget accounting under parallel batches.
- Abort propagation and late-settlement behavior.
- Tool-call/tool-result protocol validity after compaction.
- Public stream compatibility and bounded memory.

Do not release if any P0 finding remains unresolved without an explicit written risk acceptance.

## Phase 2 — Long-session performance follow-ups

Implement these as separate reviewable changes. They may target 0.10.2 if Phase 1 is otherwise ready.

### Task 2.1 — Incremental transcript partition/cache (RH-007)

- Cache Markdown root chunks by stable message identity and content signature.
- Keep committed static transcript state outside repeated full-history partitioning.
- Recompute only changed streaming tails.
- Add work-count or lexer-spy tests for a 1,000-message transcript.

### Task 2.2 — Session snapshot coalescing/compaction (RH-008)

- Record intentional checkpoints rather than every intermediate full snapshot.
- Coalesce queued snapshots before disk append.
- Add safe atomic compaction for oversized session files.
- Preserve crash recovery, permissions, malformed-line diagnostics, and empty-session behavior.
- Add long-session file-growth and restore-work tests.

### Task 2.3 — Pool LSP clients (RH-009)

- Introduce a lifecycle owner scoped to turn or session.
- Reuse initialized servers and opened documents.
- Recover from crashes and close during all teardown paths.
- Preserve frame/document/request limits.

### Task 2.4 — Allow bounded read-only queue bypass (RH-010)

- Allow read-only work behind one blocked mutation to consume idle slots.
- Keep mutation FIFO priority and cap bypass so mutation work cannot starve.
- Do not combine with lease-at-first-mutation unless separately designed/reviewed.

### Task 2.5 — Add release metadata verification (RH-011)

- Add a read-only `scripts/verify-release-metadata.*` command.
- Validate package/lockfile/docs/changelog/security version agreement.
- Report all mismatches in one run.
- Add `npm run release:verify` to CI and `prepublishOnly`.

## Validation matrix

### Per task

Run the smallest relevant test set plus:

```bash
npm run typecheck
npm run lint
```

Suggested targeted commands:

```bash
npm test -- tests/hazeTools/listFiles.test.ts tests/utils/fs.test.ts
npm test -- tests/core/process/backgroundRegistry.test.ts
npm test -- tests/cli/commands/streaming.test.ts tests/core/turnBudget.test.ts tests/core/subagent/subagentRunner.test.ts
npm test -- tests/cli/commands/streaming/idleTimer.test.ts tests/llm/mcp.test.ts tests/cli/commands/runHeadless.integration.test.ts
npm test -- tests/core/agent.test.ts tests/config/settings.test.ts tests/config/providers.test.ts
npm test -- tests/cli/chat/sessionRecorder.test.ts tests/core/sessionStore.test.ts
```

### Final release gate

```bash
npm run typecheck
npm test
npm test
npm test
npm run lint
npm run build
./scripts/check-agents-stamps.sh
npm audit --audit-level=high
npm pack --dry-run
```

Also run `npm run release:verify` after Task 2.5 exists.

### Performance evidence to record in `IMPLEMENTATION.md`

- Git subprocess count and elapsed time for first and later `listFiles` pages on at least 200 entries.
- Full-suite duration and three-run pass rate.
- Maximum underlying tool executions for an intentionally oversized parallel batch.
- Turn/tool timeout elapsed time and teardown result for a never-settling fake tool.
- Computed budgets for representative 16K, 32K, and large-context configurations.
- Total NDJSON bytes for a synthetic long response compared with final text bytes.
- If Phase 2 runs: transcript lex count, session bytes after many turns, LSP process starts across repeated calls, and scheduler utilization.

## Rollback strategy

Keep tasks in separate commits or at least separate diffs so each can be reverted independently:

1. Ignore batching/traversal.
2. Test scheduling/readiness.
3. Execution-boundary budgets.
4. Deadlines.
5. Context budgeting/configuration.
6. Streaming event contract/backpressure.
7. Each Phase 2 optimization.

For public contract changes, document downgrade behavior. Do not retain dual cumulative and delta streaming indefinitely because that restores quadratic output.

## Definition of done

- All Phase 1 acceptance criteria pass.
- Exact default release commands are green, including three consecutive full test runs.
- No critical/high finding remains after independent review.
- Documentation describes timeout and stream-contract changes.
- `STATUS.md` and `IMPLEMENTATION.md` contain validation evidence and explicit deferrals.
- Release recommendation is updated from no-go to go only after the final gate passes.
