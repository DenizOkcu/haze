# Agent runtime and completion evidence

Review baseline: `b53d4e90352a1283c4d05280017760424fd4580b` (1.2.1). See [README](README.md) for priorities, methodology, and limitations. All findings are open; no fixes were applied.

## AR-01 — Rerunning an earlier check can make a failure look passed

**Priority:** P1 · **Evidence:** reproduced with pure runtime helpers · **Confidence:** high.

**Locations:** `src/core/agent/workState.ts:165-172`, `src/core/agent/workState.ts:354-376`.

`upsertValidation` updates an existing command in place, whereas `deriveValidationOutcome` treats the last array element as the latest execution. Sequence: mutate → test A passes → check B passes → rerun A fails. A's revision changes but B remains last; the derived outcome is `passed`. The inverse can keep a repaired goal blocked. A subsequent successful read can clear the separate last-tool-failed gate, exposing the false completion outcome.

**Smallest fix:** derive the latest validation by revision, or move an updated record to the end. Make status display use the same ordering rule. Preserve the generic-versus-confirmed authority rule.

**Acceptance:** add `tests/core/workState.test.ts` cases A-green/B-green/A-red and A-red/B-red/A-green, with revisions and mutation freshness asserted. Exercise a successful read after the failed rerun in a completion-controller integration test.

## AR-02 — Mutation evidence recognizes only three file tools

**Priority:** P1 · **Evidence:** pure-helper reproduction plus caller tracing · **Confidence:** high.

**Locations:** `src/core/agent/workState.ts:252-278`, `src/cli/commands/streaming/toolPartHandlers.ts:78-95`, `src/llm/tools/toolContext.ts:167-182`.

Successful mutations increment debt only for `editFile`, `replaceLines`, and `writeFile`. `replaceInFiles`, `lspRenameSymbol`, and `lspSafeDeleteSymbol` are already mutation tools in tool context, but not in work state. Worker capsule mutations are also not projected here. A bulk replacement result with `ok: true`, `dryRun: false`, and changed files leaves mutationCount at zero; an implement goal with no validation assesses as `ready`.

**Smallest fix:** share a bounded mutation-result projection with work-state observation. Support actual multi-file results and authoritative worker changes; exclude dry runs, no-ops, failures, and duplicates. Do not infer arbitrary shell mutations from prose or add an entire command sandbox.

**Acceptance:** table-driven coverage for every built-in mutation tool, zero-change results, previews, failed/partial results, and delegated edits. Every actual change must stale prior validation and require new evidence. Pin tool-catalog/evidence parity so new tools cannot silently bypass the gate.

## AR-03 — Direct-artifact validation accepts commands that mask failures

**Priority:** P1 · **Evidence:** reproduced with pure helpers · **Confidence:** high.

**Locations:** `src/core/agent/workState.ts:175-210`, `src/core/agent/workState.ts:280-305`.

`executedMutatedArtifact` rejects `&&`, `||`, semicolons, and pipes, but accepts a newline separator and a single background `&`. Both `node app.js\ntrue` and `node app.js & true` identify the changed artifact. An ordinary shell result can therefore record passing validation from the final command even when the artifact failed or has not finished.

**Smallest fix:** reuse the existing shell command-shape safety logic rather than maintaining another partial parser. Require one foreground command with trustworthy exit provenance; if uncertain, do not mint artifact evidence.

**Acceptance:** test foreground direct execution, newline lists, background lists, comments, quoted metacharacters, substitutions, and shell-specific invocation. Use a harmless failing temporary program to prove a trailing success cannot satisfy validation.

## AR-04 — Headless relaunch preserves conversation but discards evidence

**Priority:** P1 · **Evidence:** source-traced, not provider-reproduced · **Confidence:** high.

**Locations:** `src/cli/commands/runCommand.ts:311-352`, `src/cli/commands/streaming/goalSupervisor.ts:84-92`, `src/cli/commands/streaming/goalSupervisor.ts:117-145`, `src/cli/commands/streaming/goalSupervisor.ts:236-244`.

A model error after successful mutations/task declaration can return evidence without an incomplete-goal checkpoint. `--until-done` re-enters with only `conversationCarriesRequest`; a fresh supervisor has no checkpoint and seeds zero mutation debt, no task counts, and no unresolved red evidence. Conversation text is not structured completion evidence. The next attempt can finish without satisfying the prior obligations. An idle resume similarly does not carry those fields.

**Smallest fix:** use one goal-scoped checkpoint/evidence carrier for transient failures and idle resumes as well as budget continuations. Retain the exact unresolved red-check identity, which cannot be reconstructed from the public count-only evidence envelope. Reuse the existing goal identity and mutation scope where appropriate.

**Acceptance:** headless integration: edit + pending task + failing validation → transient provider failure → relaunch produces only final prose. It must remain incomplete. Then update tasks and run matching green validation and verify completion. Assert counts do not reset across multiple relaunches.

## AR-05 — Idle-stall relaunch loses the resume marker and can repeat the request

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/cli/commands/runCommand.ts:346-352`, `src/cli/commands/streaming/goalSupervisor.ts:123`, `src/cli/commands/streaming/goalSupervisor.ts:168-193`.

The relaunch code forwards only `incomplete-goal` resumes. If resume is `model-stream-idle`, it also suppresses `conversationCarriesRequest` because a resume object exists. The new supervisor receives neither marker and treats the next run as a new request. This contradicts the adjacent comment and risks duplicating the user request instead of resuming preserved history.

**Smallest fix:** explicitly handle both resume variants and define retry-pool reset behavior for headless relaunch. Coordinate with AR-04 rather than adding a third continuation representation.

**Acceptance:** an exhausted idle stall with preserved history must relaunch with exactly one original user request and without replaying completed tool calls.

## AR-06 — Deadline cleanup is not a permanent cancellation barrier

**Priority:** P2 · **Evidence:** reproduced with pure helpers · **Confidence:** high.

**Locations:** `src/core/deadline.ts:19-46`, `src/core/deadline.ts:57-77`.

After `createAbsoluteDeadline().clear()`, aborting its parent still calls `onTimeout`: clear removes only the timer, not the listener or armed state. `withToolDeadline` retains its abort listener after normal completion and invokes `execute()` even when the supplied signal is already aborted. Repeated tools retain closures until turn abort and can generate listener warnings; cleared deadlines can still mutate owner state.

**Smallest fix:** explicit idempotent disposal that removes listeners and prevents rearming/firing; check pre-aborted signals before invoking work. Keep logical timeout distinct from physical cancellation.

**Acceptance:** listener count returns to baseline after success/error/timeout; clearing then aborting does not fire; already-aborted input never executes work; timeout resolves once and late rejection remains handled.

## AR-07 — Newly added compaction callback bypasses quarantine

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/cli/commands/streaming/attemptLifecycle.ts:69-98`, `src/cli/commands/chat.tsx:583-584`.

The callback guard spreads every callback, then overrides a hand-maintained list. `recordCompaction` is not overridden. An abandoned attempt that finishes a late summary can still write a compaction entry through the original session recorder after quarantine. The all-state-mutations-blocked contract is therefore incomplete.

**Smallest fix:** guard `recordCompaction`; make callback categories explicit/type-checked so additions require a quarantine decision. Do not introduce a general proxy framework.

**Acceptance:** invoke every state-mutating callback after quarantine, including recordCompaction, and assert no UI, conversation, ledger, or session write occurs. Read-only accessors/debug logging may retain their documented behavior.

## AR-08 — Failed workers lose their completed-change and validation capsule

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/core/subagent/subagentRunner.ts:84-88`, `src/core/subagent/subagentRunner.ts:124-176`, `src/core/subagent/subagentRunner.ts:207-219`.

The error path creates a terminal capsule with empty changedPaths and validation even after successful tools populated both collections. It restores telemetry but not those capsule fields. Only the capsule reaches the parent model (`:269`), so a worker that edited and then lost its provider connection looks like it left no structured change evidence. This makes safe recovery and AR-02 evidence propagation harder.

**Smallest fix:** preserve bounded, confirmed changed paths and validation records on failure, mark termination/usable honestly, and distinguish unknown in-flight effects from completed effects. Do not report success merely because some tools ran.

**Acceptance:** mock an edit and validation followed by a provider error; parent capsule must expose the completed work while remaining failed. Cover cancellation and coordinator deadline delivery separately, since early logical termination cannot know later physical effects.
