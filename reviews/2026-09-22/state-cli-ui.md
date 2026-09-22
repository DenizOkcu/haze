# Persistence, headless output, and interactive lifecycle

See [README](README.md). Findings remain open. UI behavior here is primarily source-traced; no live terminal resize/provider session was exercised.

## SU-01 — A resumed goal can disappear from crash recovery

**Priority:** P1 · **Evidence:** source-traced state sequence · **Confidence:** high.

**Locations:** `src/core/session/sessionStore.ts:370-380`, `src/core/session/sessionStore.ts:407-428`, `src/cli/commands/streaming/goalSupervisor.ts:117-118`, `src/cli/commands/streaming/goalSupervisor.ts:151-159`.

A paused goal writes goal_end with failed status. Explicit resume reuses its goalId and appends a new goal_start. If the process then crashes, restoreSessionState records that ID in terminatedGoals from the earlier end and clears the newer frontier at line 427. The pure findGoalLedgerFrontier helper does not use that lifetime set and disagrees on the same sequence. This is a DRY failure affecting recovery, not merely duplicate syntax.

**Smallest fix:** one ordered frontier transition helper shared by streaming restoration and list-based lookup; a later start/continue must reopen that ID. Preserve the distinction between an orderly pause and an unterminated resumed run.

**Acceptance:** start → failed end → same-ID start → crash restores the new frontier; a final later end clears it. Both APIs must return identical results, including malformed trailing lines and interleaved IDs.

## SU-02 — /clear is not durable until another conversation snapshot arrives

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/cli/chat/sessionLifecycle.ts:217-227`, `src/core/session/sessionStore.ts:412-425`.

clearConversation clears the in-memory conversation and records a named clear event, but no empty snapshot. Restoration only replaces messages on conversation_snapshot and ignores the clear event. Clear, exit, and resume can therefore restore the supposedly cleared conversation. Old work state/frontier may survive as well.

**Smallest fix:** persist an explicit reset/empty snapshot with well-defined work-state/frontier semantics, or teach restoration to apply the existing clear event consistently. Preserve lazy creation: clearing a never-used session must not create a resumable empty session.

**Acceptance:** persisted conversation → clear → flush → restore yields an empty conversation and no obsolete active work. Test immediate exit, resume, and new input after clear. The old audit trail may remain; this is not a request for secure deletion.

## SU-03 — Manual compaction is unbounded and can overwrite newer conversation

**Priority:** P1 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/cli/chat/sessionLifecycle.ts:234-261`, `src/cli/commands/chat.tsx:350-418`, `src/cli/commands/chat.tsx:400-401`.

Manual LLM compaction captures the current conversation, awaits generateText with no abort signal, timeout, output cap, or providerRequestSettings, then unconditionally replaces the conversation. The slash path does not set busy for this operation. A second prompt or session-changing command can proceed while the summary is pending; its later completion can overwrite newer state or write the old summary to the new session. An unresponsive summarizer never reaches the fallback.

**Smallest fix:** route manual compaction through a bounded cancellable operation; serialize it against submissions/session changes or compare session identity and conversation revision before commit. Reuse model-specific request settings and existing compaction limits rather than another model-call policy.

**Acceptance:** deferred summary plus /new, /clear, or new input must not overwrite the new state. Hung/aborted summary falls back or reports cancellation promptly. Confirm provider-specific options and output bounds with a fake model.

## SU-04 — Recovery commands erase the one-key resume they are meant to enable

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/cli/commands/chat.tsx:369-372`, `src/cli/commands/chat.tsx:503-511`, `src/cli/commands/streaming/goalSupervisor.ts:210-217`.

Context exhaustion tells the user to compact or switch models and then resume. But every submission clears pausedResume before dispatch, including /compact and /model. After the recommended recovery action, the R affordance/checkpoint is gone. The UI also labels every incomplete-goal pause as no measurable progress (`chat.tsx:686-688`), losing deadline/context-specific diagnosis.

**Smallest fix:** distinguish a new goal or reset from a recovery/configuration command. Preserve the checkpoint through operations intended to repair its environment, and render the actual pause reason. Define /clear semantics explicitly rather than blindly retaining a checkpoint whose history was removed.

**Acceptance:** context-exhausted pause → /compact or model change → R resumes the same goal with its debt. New user goal and /new supersede it; labels distinguish actual stop reasons.

## SU-05 — NDJSON drain handling does not bound producer memory or output failure

**Priority:** P2 · **Type:** resource/automation reliability risk · **Evidence:** source-traced.

**Locations:** `src/cli/commands/ndjsonSink.ts:20-42`, `src/cli/commands/runCommand.ts:236-246`, `src/cli/commands/runCommand.ts:379-393`.

The sink serializes writes and awaits drain, but callers enqueue without awaiting, so a slow consumer can accumulate unbounded serialized lines/promises. Errors are listened for only when write returns false; an asynchronous error after a true return has no sink listener. End-of-run flush/write errors are swallowed and the exit status still depends only on goal completion. A successful agent run can therefore be reported with an unusable output stream.

**Smallest fix:** establish a bounded queue/backpressure policy at the event producer, permanent stream error/close handling, and an explicit output-delivery failure outcome. Coalesce transient updates only if terminal events and reconstruction semantics remain intact. Reuse the ordered-writer idea, not its unbounded queue blindly.

**Acceptance:** controlled slow/broken Writable fixtures cover queue bounds, true-return followed by asynchronous error, close-before-drain, correct terminal ordering, and non-success exit when the required result cannot be delivered.

## SU-06 — Mention completion can apply a stale token's results

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** medium; needs interaction reproduction.

**Locations:** `src/ui/components/useInputSuggestions.ts:38-60`.

Async responses are cancellation-guarded, which is good, but the previous suggestion list remains visible while a new token is being fetched. `detectedMention` refers to the current token immediately while activeSuggestion can still come from the prior token. A fast Tab during that interval can complete the new token using an old token's entry. The fetch effect also omits the provider callback from dependencies.

**Smallest fix:** associate results with the token/range/provider that produced them and expose them only while that identity matches the current mention; otherwise show loading/empty. Avoid duplicating synchronously derivable mention state unless necessary.

**Acceptance:** resolve token A, change to B while its promise remains pending, press Tab, then resolve A/B out of order. No stale completion may be applied. Also test a changed provider callback with an unchanged token.
