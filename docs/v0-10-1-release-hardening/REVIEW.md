# v0.10.1 Release Hardening Review

## Review round 1

- Date: 2026-08-13
- Verdict: **changes-required**
- Gate decision: **G4 fail**
- Scope: Phase 1 uncommitted product, test, configuration, and public-documentation changes for RH-001 through RH-006. Phase 2 deferrals were not treated as defects.

The patch improves the flat-directory Git case, enforces the main turn-wide tool envelope at the execution boundary, adds request-envelope budgeting, emits patch-style stream events, and serializes NDJSON writes. However, five high-severity findings leave Phase 1 acceptance criteria unresolved. The release should enter a review-fix phase and return for review round 2.

## Security findings

### HIGH — S1: Git output normalization exposes ignored POSIX paths containing backslashes

**References:** `src/llm/tools/gitIgnore.ts:68-71`, `src/llm/tools/gitIgnore.ts:86-91`; affected callers include `src/llm/tools/fileToolShared.ts:10-20` and `src/llm/hazeTools.ts:61-74`.

Candidates are submitted to Git with their exact POSIX backslash characters, but every returned match is normalized with `replaceAll('\\', '/')`. On POSIX, `\\` is a legal filename character, not a separator. Git returns the exact NUL-delimited input path, so an ignored `a\b.txt` becomes `a/b.txt` during lookup and is not marked ignored. This affects `listFiles` and the shared single-path ignore check used by read/mutation preparation, violating the default gitignore safety contract.

Independent reproduction returned `gitOutput: "a\\b.txt"`, `normalized: "a/b.txt"`, and `exactMatch: false` from a real temporary Git repository. The current test uses a mocked runner and spaces only (`tests/hazeTools/gitIgnore.test.ts:6-16`), so it does not exercise real NUL output or separator-sensitive names.

**Required:** preserve exact output-to-input identity on POSIX (and define platform-correct mapping on Windows), then add real-Git tests for spaces, newlines, backslashes, nested ignored directories, negation, and exact duplicate input mapping.

## Correctness, reliability, and performance findings

### HIGH — C1: Recursive `listFiles` can still start one Git process per entry

**References:** `src/utils/fs.ts:41-44`, `src/utils/fs.ts:71-82`, `src/llm/hazeTools.ts:61-74`; insufficient regression coverage at `tests/utils/fs.test.ts:66-105` and `tests/hazeTools/gitIgnore.test.ts:6-16`.

`walkDir` batches only the siblings returned by one `readdir`. It awaits `filterBatch` before descending, and every recursive directory starts a fresh batch. `listFiles` maps each such callback directly to `classifyGitIgnored`, which starts one Git process for every non-empty callback. A 40-entry single-child directory chain produced 40 filter batches for 40 candidates; production therefore starts 40 Git processes. Broad trees with one/few entries per directory have the same O(directory-count) process cliff, up to the page traversal bound.

The 600-candidate operation-count test calls `classifyGitIgnored` directly with one flat array; the `walkDir` test also uses a flat directory and does not count Git invocations. Consequently, the RH-001 claim and acceptance criterion are unsupported for recursive trees.

**Required:** batch classification across recursive traversal/frontiers while retaining ignored-directory pruning and early page termination. Add an actual `listFiles` operation-count test over deep and sparse/wide trees, plus first/later-page assertions.

### HIGH — C2: Recovery-slice execution caps reset after a provider retry

**References:** `src/cli/commands/streaming.ts:316-334`, `src/cli/commands/streaming.ts:646-669`, `src/cli/commands/streaming.ts:728-753`; insufficient test at `tests/cli/commands/streaming.test.ts:282-300`.

The turn-wide counter is shared, but `toolBudget` and `executionLimit` are recreated inside every `runAgentAttempt`. When a recovery slice starts one or more tools and a later provider step fails retryably, `runAgentTurn` retries with the same `activeOptions.recoverySlice`; the new attempt receives the full `recoverySlice.maxToolCalls` again. A nominal two-call rescue can therefore execute more than two mutations across retries (while remaining under the much larger 120-call turn envelope).

The added test invokes wrappers only after each mocked turn has already completed and never drives “tool execution, retryable provider failure, retry, second execution batch.” It proves per-wrapper parallel atomicity, not recovery accounting across retries.

**Required:** keep one slice execution state/remaining allowance across all retries in that slice, and add deterministic oversized-parallel plus retry tests for both main and recovery accounting. Blocked mutating calls must remain side-effect free.

### HIGH — C3: Absolute timeout can return before owned MCP/resources are cleaned up

**References:** `src/cli/commands/streaming.ts:673-678`, `src/cli/commands/streaming.ts:694-707`, `src/cli/commands/streaming.ts:726-765`; MCP ownership at `src/llm/mcp.ts:84-93`, close path at `src/llm/mcp.ts:122-124`.

The outer `withDeadline` races `runAgentAttempt` and returns as soon as the deadline fires. Callback guards quarantine UI/session callbacks, but cleanup of MCP clients, the idle timer, and tool-display resources remains solely in the still-running attempt's `finally`. If a provider stream ignores abort and never settles, that `finally` never runs. A configured stdio MCP client can therefore keep child-process/stdio handles alive after headless result delivery, so the process itself may still fail to terminate. This is logical-result quarantine, not bounded resource teardown.

The timeout test uses `hangUntilAbort`, which explicitly settles on abort (`tests/cli/commands/streaming.test.ts:659-669`); it does not cover an abort-ignoring model stream, a loaded MCP client, cleanup completion, or late state/resource activity. The IMPLEMENTATION.md claim that cancellation/teardown is bounded is therefore not established.

**Required:** move cleanup ownership to a turn-level construct that can close/abort resources at the absolute deadline without waiting for the attempt, while keeping close operations bounded and idempotent. Test an abort-ignoring stream with a loaded stdio-like MCP client and assert prompt terminal delivery, close invocation, no late callbacks, no unhandled rejection, and no retained handles.

### HIGH — C4: Provider-overflow recovery is neither model-aware nor progressively smaller

**References:** request budgeting at `src/cli/commands/streaming.ts:221-250` and `src/cli/commands/streaming.ts:355-365`; overflow path at `src/cli/commands/streaming.ts:653-662`; compaction callback at `src/cli/chat/sessionLifecycle.ts:199-212`.

Initial and between-step estimates use the selected model budget, but a provider-reported overflow delegates to `compactConversation`, which recomputes a fixed fallback budget with an empty system prompt and no tool schemas. It has no selected-model window, current request overhead, retry shrink factor, or latest completed-step target. For a conservatively estimated request with 12 or fewer messages, provider tokenization can still overflow while fallback compaction returns `false`, preventing the promised retry. Only one overflow recovery is allowed, and its target does not progressively decrease.

This leaves RH-005's explicit overflow acceptance criteria unmet. There is also no test that causes multi-step growth, verifies protocol-safe compaction before the next provider request, preserves completed evidence through overflow, or proves a smaller bounded retry target.

**Required:** make overflow recovery consume the same request budget and current accumulated response evidence as normal assembly, shrink the message target on retry, and terminate after a bounded number of strictly decreasing attempts. Add protocol-valid tool-call/tool-result tests around the compaction boundary.

### MEDIUM — C5: NDJSON backpressure/error handling is only partial

**References:** `src/cli/commands/ndjsonSink.ts:9-49`, synchronous producer use at `src/cli/commands/runCommand.ts:159-164`, terminal flush at `src/cli/commands/runCommand.ts:217-221`.

The sink serializes and queues every event immediately; `write()` returns `void`, so a blocked stdout pauses later physical writes but does not backpressure the model/event producer. Queue memory can grow for the entire blocked stream. In addition, an `error` listener exists only while a prior `write()` returned `false`; an asynchronous `error` after an accepted write has no sink listener and can become an uncaught EventEmitter error. Current tests cover one false-write/drain sequence and serialization count, but not accepted-write errors, close-before-drain, repeated backpressure, bounded queueing, or flush failure through `runHeadless`.

**Required:** install lifecycle-wide error handling and provide bounded/awaitable producer flow (or a demonstrably bounded queue). Add error/close/backpressure tests and verify the result line is emitted only after prior events or that failure is surfaced deterministically.

### MEDIUM — C6: Tool timeout events can be duplicated and report the wrong duration

**References:** `src/cli/commands/streaming.ts:327-334`, `src/cli/commands/streaming.ts:368-372`, and `src/cli/commands/streaming.ts:519-526`.

A timeout can be emitted once from `prepareStep` using the 10-minute default and again when the streamed tool result is observed using the result's timeout. For the 20-minute `subagent` override, consumers may receive conflicting 10-minute and 20-minute events. An absolute-turn abort is also represented by the tool wrapper as a tool timeout when the parent abort reason is `DeadlineError`, even if the per-tool deadline did not expire.

**Required:** emit one timeout event per timeout cause with the actual elapsed/configured bound and distinguish parent turn cancellation from a per-tool deadline.

### LOW — C7: Delta generation still performs quadratic prefix work

**Reference:** `src/cli/commands/streaming.ts:469-486`.

For append-only output, every update scans the complete previous display text to rediscover the common prefix. Combined with recomputing sanitized display text from the accumulated segment, this remains O(n²) CPU for many small deltas even though emitted NDJSON bytes are now linear. This does not invalidate the patch event contract, but it retains a long-response performance cliff.

### LOW — C8: `ignoredSkipped` can count entries the page traversal never consumed

**References:** `src/utils/fs.ts:71-82`, `src/llm/hazeTools.ts:66-71`.

A whole sibling batch is classified and increments `ignoredSkipped` before `walkDir` stops after enough accepted entries. Ignored entries later in that batch may be counted even though traversal never reaches them. The entry/cursor page is correct, but model-facing diagnostics are no longer exact.

## Required-fix checklist

- [ ] Preserve exact Git NUL path mapping, including POSIX backslashes, with real-Git unusual-name tests.
- [ ] Remove per-directory/per-entry Git subprocess scaling in deep and sparse recursive trees; test actual `listFiles` runner counts.
- [ ] Persist recovery-slice execution accounting across provider retries and test parallel mutation blocking through retry.
- [ ] Ensure absolute-deadline cleanup closes attempt-owned MCP/resources even when model/tool work ignores abort.
- [ ] Make provider-overflow recovery selected-model-aware, protocol-safe, evidence-preserving, bounded, and strictly decreasing.
- [ ] Make NDJSON error handling lifecycle-safe and producer backpressure/queue memory bounded.
- [ ] Emit one accurately classified timeout event per cause.
- [ ] Add the missing regression tests described above; rerun review round 2.

## Optional suggestions

- Replace full-prefix rescans with an incremental append fast path and invoke reset diffing only when display sanitization actually rewrites a suffix.
- Define whether `ignoredSkipped` means “classified in the look-ahead batch” or “encountered before the returned page ended”; prefer the latter for compatibility.
- Add a platform matrix test for cursor separators and unusual Git names on Windows and POSIX.

## IMPLEMENTATION.md claim assessment

Supported by review/tests:

- Flat candidate arrays use bounded Git batches.
- Cursor resume avoids filtering earlier sibling branches in the tested traversal shapes.
- Main turn-wide wrapper accounting is synchronous at `execute` and blocks oversized calls for one wrapper instance.
- Request arithmetic subtracts estimated system prompt, tool schemas, output reserve, and safety margin.
- Patch events reconstruct append-only Unicode output, session recording skips transient updates, and queued writes preserve order through one simulated drain.
- The focused changed-area tests and typecheck pass.

Not supported or contradicted:

- “Bounded number of Git subprocesses” does not hold across recursive directory topology.
- “Exact input-path mapping” fails for POSIX backslashes.
- Recovery-slice limits are not shared across retries.
- Absolute timeout does not guarantee physical resource cleanup for abort-ignoring attempts.
- Overflow recovery does not use a progressively smaller selected-model request target.
- NDJSON pauses physical writes but does not fully propagate backpressure or safely observe all output errors.

## Validation reviewed

Independent review ran:

- `git diff --check` — passed.
- `npm run typecheck` — passed.
- Focused Vitest command covering Git ignore/list traversal, execution budget/deadline, context budgeting, NDJSON, streaming/headless, and MCP — **10 files, 83 tests passed**.
- Real-Git unusual-name reproduction — confirmed the POSIX backslash mapping defect.
- Synthetic 40-level recursive traversal — **40 entries, 40 filter batches**, confirming per-directory process scaling at the `listFiles` integration boundary.

The implementation agent's three full-suite runs, lint, build, AGENTS stamp check, audit, and package dry run were reviewed as recorded evidence but were not all independently repeated in this review session.

## Validation required after fixes

1. Run focused regressions for every checklist item, including real Git and abort-ignoring resource cases.
2. Run `npm run typecheck && npm run lint`.
3. Run the exact `npm test` command three consecutive times.
4. Run `npm run build`, `./scripts/check-agents-stamps.sh`, `npm audit --audit-level=high`, and `npm pack --dry-run`.
5. Return for independent review round 2; do not mark release go before G4 passes.

---

## Review round 2

- Date: 2026-08-13
- Verdict: **changes-required**
- Gate decision: **G4 fail**
- Scope: Complete uncommitted diff, including every round-1 fix and its tests. Phase 2 and optional round-1 C7/C8 remained deferred.

Round 2 independently confirms that S1, C1's process-count fix, C2's no-overshoot guarantee, C4, C5, and C6 are materially resolved. However, C3's bounded-cleanup claim is still incomplete: late output from an abort-ignoring stream can reacquire timers after the one-shot cleanup has run. The new persistent Git classifier also has an unbounded active-query/close path. These high-severity long-running-task failures keep the release at no-go.

### Prior required finding verification

| Finding | Round 2 result | Evidence |
|---|---|---|
| S1 exact Git path identity | **resolved** | Shared mapping preserves POSIX backslashes and duplicate aliases. Real-Git unusual-name tests pass; an independent `listFiles` reproduction hid newline and backslash names correctly. |
| C1 recursive Git process scaling | **resolved for process count** | `listFiles` owns one persistent process per operation; deep/sparse first and later page tests pass. Cursor traversal skips prior branches and preserves ordering/non-overlap in the covered shapes. The separate unbounded-process finding R2-C2 remains. |
| C2 recovery accounting across retries | **resolved for cap enforcement** | Shared slice state survives provider retries, and oversized mutation batches cannot exceed the slice or turn envelope. R2-C3 identifies under-utilization near the global boundary, not overshoot. |
| C3 absolute-deadline cleanup | **not resolved** | MCP close is one-shot/idempotent, but cleanup is not a permanent quiescence barrier. A late stream part can rearm cleaned timers after terminal delivery (R2-C1). |
| C4 model-aware overflow recovery | **resolved** | Recovery uses the selected request budget, retains completed response evidence, preserves recent tool protocol pairs, caps attempts, and strictly decreases the successful retry target. |
| C5 NDJSON lifecycle/backpressure | **resolved** | Writes are awaitable and ordered, queue bytes are capped, error/close listeners cover the sink lifetime, repeated drain is handled, and terminal output waits for prior writes. Focused error/backpressure/headless tests pass. |
| C6 timeout event accuracy | **resolved for parent-vs-tool classification** | Parent cancellation is not converted to a per-tool timeout; the actual structured tool result emits one event with its configured bound. R2-C4 covers the separate unreported idle-timeout cause. |

## Security findings

No critical credential, command-injection, workspace-confinement, or ignored-path disclosure regression was found. S1 is fixed. The persistent classifier continues to fail open on explicit operational errors as documented, but it does not fail open or terminate when the protocol remains alive and incomplete; that availability defect is recorded below.

## Correctness, reliability, performance, and test-quality findings

### HIGH — R2-C1: Late abort-ignoring stream output can reacquire resources after cleanup

**References:** `src/cli/commands/streaming.ts:193-198`, `src/cli/commands/streaming.ts:472-480`, `src/cli/commands/streaming.ts:714-720`; `src/core/agent/resourceScope.ts:11-28`; `src/cli/commands/streaming/idleTimer.ts:36-44`; insufficient regression at `tests/cli/commands/streaming.test.ts` in the abort-ignoring MCP cleanup case.

At the absolute deadline, `ResourceCleanupScope.close()` runs `idleTimer.clear()`, stops/finalizes the tool renderer, and closes MCP clients. The registered cleanup is permanently marked finished. If the abort-ignoring stream later yields a part instead of immediately rejecting, the loop calls `idleTimer.reset()` before checking the part. Late tool parts can also restart the renderer's interval and late logging still has the raw `LlmLog` reference. The idempotent cleanup cannot run again, so these newly acquired handles/activity survive the claimed teardown barrier. Repeated late parts can keep rearming them indefinitely.

The round-1 regression releases the late stream directly into a rejection, so it never exercises the post-cleanup loop body. An independent focused reproduction closed a `ResourceCleanupScope`, mirrored the late `idleTimer.reset()`, and observed `firedAfterScopeClosed: true`. This contradicts the terminal message that late settlement was quarantined and owned resources were closed.

**Required:** make scope closure a permanent quiescence barrier, not only a one-time cleanup. Late stream iterations must exit before resetting timers, touching tool-display state, or logging. Track/bound in-progress cleanup and prevent resource reacquisition after close. Keep MCP close exactly once. Add an abort-ignoring regression that yields late text and tool parts after terminal delivery and proves no callbacks, log writes, timers, intervals, retained handles, or duplicate MCP closes occur. Report teardown timeout truthfully instead of always claiming all resources closed.

### HIGH — R2-C2: Persistent `git check-ignore` queries and close are unbounded and ignore turn cancellation

**References:** `src/llm/tools/gitIgnore.ts:130-149`, `src/llm/tools/gitIgnore.ts:190-224`; caller `src/llm/hazeTools.ts:60-80`.

A classifier query resolves only after Git emits one complete four-field record per submitted path, errors, or closes. It has no query deadline or abort signal. `close()` first awaits the query chain and only then starts its one-second close timer. Therefore a live Git process that stops reading or emits an incomplete response leaves both `classify()` and `close()` pending forever. The main per-tool deadline settles logically, but `listFiles` does not propagate that abort into this child and the child is not owned by the turn resource scope, so it can retain the process after the turn returns.

Independent reproduction used a Git shim that accepted an active query but emitted no records for two seconds. `close()` took about 2.1 seconds despite the declared one-second close bound; a permanently silent process would never reach that timer. Existing tests cover process count and valid real-Git records, but not stalled stdin/stdout, incomplete records, abort, or bounded close.

**Required:** give each active query a bounded deadline/abort path; on timeout, malformed/incomplete protocol, stdin failure, or parent abort, resolve fail-open and immediately begin bounded process-tree/stdio teardown. `close()` must never wait unboundedly for `chain` before enforcing its deadline, and it must not return while an escaped child handle remains. Thread the tool execution abort signal to the classifier. Add deterministic hung, partial-record, write/backpressure/error, abort, and close-bound regressions while retaining one process per list operation and exact unusual-path mapping.

### MEDIUM — R2-C3: Shared recovery state double-counts the global remainder near exhaustion

**References:** `src/cli/commands/streaming.ts:340-353`, `src/cli/commands/streaming.ts:742-744`, `src/cli/commands/streaming.ts:756-774`.

The recovery-slice state correctly persists across retries, but every retry recomputes `executionLimit` from the already-decremented global remainder and then compares that smaller limit with the slice state's cumulative `started` count. For example, with two global calls remaining and a two-call slice, one call before a provider retry leaves global remainder one and slice `started` one; the next wrapper uses limit one and blocks the second call. The cap cannot overshoot, but a promised remaining recovery call is lost, which can leave long autonomous work incomplete near the boundary. The `[2, 4]` retry regression consumes the whole slice before retry and misses this case.

**Required:** enforce the global envelope and slice envelope without subtracting the same starts twice (for example, separate shared states or a fixed slice allowance clamped once at slice admission). Add a near-global-boundary `1 + retry + 1` test that starts both allowed calls and blocks the third.

### MEDIUM — R2-C4: Idle model-stream timeout is not represented by the timeout event protocol

**References:** `src/cli/commands/streaming.ts:186-190`, `src/cli/commands/streaming.ts:537`, `src/cli/commands/streaming.ts:714-720`; `src/core/agent/events.ts:24`.

Per-tool and absolute-turn deadlines are now classified accurately, but the existing idle timer aborts with a string and emits no `timeout` event. A headless harness sees an aborted turn without whether model streaming stalled, despite the plan requiring phase-specific timeout diagnostics. The event union has only `turn | tool | teardown`, so this cause cannot be represented precisely.

**Required:** emit one bounded timeout event for idle/model-stream expiry with an unambiguous phase/cause, without converting user cancellation into timeout. Add headless and streaming tests distinguishing idle expiry, absolute turn expiry, per-tool expiry, teardown expiry, and manual cancellation.

### MEDIUM — R2-C5: CLI help contradicts implemented overflow recovery

**Reference:** `src/cli/index.ts:52-55`; implementation at `src/cli/commands/streaming.ts:664-680`.

Print-mode help still says, “There is no automatic context-overflow recovery,” while the patch now performs up to three selected-model-aware decreasing retries in `runAgentTurn`, including headless calls. README removed the old claim, so the public documentation is internally inconsistent.

**Required:** update the authoritative CLI help to describe the bounded automatic recovery accurately and add/adjust a help-text assertion if one exists.

## Required-fix checklist

- [ ] Permanently quiesce late abort-ignoring attempts after absolute timeout; prevent timer/interval/log reacquisition and prove MCP cleanup remains bounded and exactly once.
- [ ] Bound and abort the persistent Git query and its process/stdio teardown without waiting for protocol completion; preserve fail-open and exact-path behavior.
- [ ] Remove recovery-slice/global-remainder double counting and test one allowed execution on each side of a provider retry near the global cap.
- [ ] Emit an accurately classified idle/model-stream timeout event distinct from absolute turn, tool, teardown, and user cancellation.
- [ ] Correct the print-mode overflow-recovery help text.
- [ ] Add the deterministic regressions described above, rerun the focused suite, then run the complete release gate and return for review round 3.

## Optional suggestions

- Add a real-Git test through the persistent `listFiles` classifier (not only the one-shot classifier) for newline/backslash/duplicate aliases, even though independent round-2 reproduction confirms the shared mapping currently works.
- Consider binary-searching the sorted sibling array at each cursor level to avoid a linear cursor lookup in very wide directories. Current traversal avoids prior subtree/filter work and is functionally ordered, but still scans sibling names up to the cursor.
- Remove or dispose NDJSON sink listeners explicitly if `runHeadless` ever becomes a reusable in-process API; one CLI invocation currently creates only one sink.

## Validation reviewed

Independent round 2 ran:

- `git diff --check` — passed.
- Focused required-finding suite — **11 files, 115 tests passed**.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- Exact canonical `npm test` — **139 files, 1,361 tests passed** in 19.78 seconds.
- Real-Git unusual-name `listFiles` reproduction — ignored newline and POSIX-backslash names remained hidden.
- Resource reacquisition reproduction — a late idle reset fired after `ResourceCleanupScope.close()`.
- Persistent Git close reproduction — active incomplete protocol delayed close to about 2.1 seconds despite the one-second close constant.

The review also checked the implementation agent's recorded three canonical suite passes, build, AGENTS stamps, audit, and package dry run. Build/package/audit were not independently repeated because round 2 found source-level release blockers before those final gates.

## Round 2 gate decision

**G4 remains failed.** There are two high-severity unresolved reliability findings and three required medium fixes. Do not proceed to production-readiness. Run a narrow review-fix round 2, preserve Phase 2 and C7/C8 deferrals, execute the complete release gate, and return for the final review round 3.
