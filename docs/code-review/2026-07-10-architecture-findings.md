# haze 0.8.0 correctness and architecture findings

The priorities below account for product truth and implementation risk, not file size alone.

## ARC-01 — Turn completion and headless status are not authoritative

**Priority:** P0  
**Files:** `src/cli/commands/streaming.ts`, `src/core/goal/completionPolicy.ts`

After the stream/response handling finishes, `runAgentTurn` unconditionally sets the goal to done and `turnStatus = 'complete'` (`streaming.ts:393-396`). If the agent stopped because `MAIN_STEP_LIMIT`, `MAIN_TOOL_CALL_LIMIT`, or `MAIN_TOOL_ONLY_STEP_LIMIT` was reached, haze can emit “Finished tool work.” and still report complete. There is no check of finish reason, unmet work-state criteria, tool failures, or missing final text.

This is especially serious in `--output json`/`stream-json`, where the README promises that status is authoritative for CI. A supervisor can receive exit 0 for unfinished work.

The codebase already has a tested `completionDecision()` plus continuation prompts in `src/core/goal/completionPolicy.ts`, but only repeated-tool/tool-budget prompt helpers are imported by the runtime. The central policy is currently dead production code: tests prove an abstraction that does not protect behavior.

**KISS direction:** Do not add another classifier. Define a small explicit terminal-outcome function using facts the runtime already has:

- abort/error;
- final finish reason/step limit;
- whether a structured tool failed;
- whether the last model output is substantive;
- intent and work-state evidence;
- whether one bounded continuation is warranted.

Either wire the existing completion policy into that function or delete it and test the simpler replacement. Return `complete` only when the attempt reached a genuine final answer/outcome; otherwise return `failed` or a new documented `partial` status (adding a status is a public API decision).

**Acceptance tests:** headless action stopped at budget is non-zero; failed final tool plus no recovery is non-complete; a review/answer without mutations can complete; successful mutation with honest “validation not run” can complete if policy allows; no-text-after-tools cannot become a false success.

## ARC-02 — Structured tool failures are emitted and logged as successes

**Priority:** P0  
**Files:** `src/cli/commands/streaming.ts`, `src/core/agent/events.ts`

For every AI SDK `tool-result` part, the runtime emits `tool_end.success: true` and logs `toolResult.success: true` (`streaming.ts:313-320`) before calculating `const ok = toolOutputOk(part.output, true)`. Built-in recoverable failures use normal tool results shaped as `{ok:false}`, so:

- the UI item correctly becomes error;
- work-state correctly sees failure;
- headless NDJSON says success;
- durable session events and debug logs say success.

This is one event translated three different ways, violating DRY and making audit/harness behavior unreliable.

**Fix:** Calculate `ok` once before rendering/events/logging and use it everywhere. Keep transport execution failure (`tool-error`) distinct from structured domain failure if needed with an additive `transportSuccess` field, but public `success` should match user-visible outcome.

**Acceptance tests:** `{ok:false}` yields `tool_end.success:false`, error UI, failed work-state observation, and failed debug-log result; `{ok:true}` and outputs without `ok` remain successful.

## ARC-03 — Session and debug-log writes are unordered and silently lossy

**Priority:** P1  
**Files:** `src/cli/chat/sessionRecorder.ts`, `src/core/session/sessionStore.ts`, `src/cli/commands/streaming.ts`, `src/core/log/llmLog.ts`

`createSessionRecorder` fires every append without awaiting and swallows every error. Streaming log entries do the same. Consequences:

- conversation snapshots can reach disk out of order, so resume can select a stale final snapshot;
- `endLog()` can be written before earlier pending entries;
- process exit can drop pending writes;
- disk-full/permission failures are invisible;
- multiple large JSONL appends have no serialized ordering guarantee.

**DRY/KISS direction:** Add one ordered append queue per open session/log. A tiny promise chain is enough. Expose `flush()` and call it at turn/session/log end. Surface the first persistence failure once in debug/system UI rather than crashing the active model turn.

Do not introduce a database or event-sourcing framework.

**Acceptance tests:** deliberately delayed append operations preserve invocation order; `flush()` waits for all entries; stale snapshots cannot become last; write failure is observable; closing the app flushes pending entries.

## ARC-04 — `grep` does not enforce a true global execution cap

**Priority:** P1  
**File:** `src/llm/hazeTools.ts`

The command passes ripgrep `--max-count <maxMatches>`, which is a per-file match limit, not a global limit. `execFile` captures the entire JSON stream and only `parseRipgrepJsonStream` applies the global returned-result cap afterward. On a large repository this can hit Node's `execFile` max buffer and fail, or perform/output far more work than the schema promises.

This is separate from SEC-04's ignored-path bypass.

**Fix:** Spawn ripgrep and parse JSON incrementally. Stop/terminate the child after the global match cap plus required context/end events is reached. Bound stderr separately and report whether the process was intentionally stopped. Reuse the bounded subprocess collector where possible, but keep ripgrep JSON parsing explicit.

**Acceptance tests:** many files with many matches return at most the global cap, do not hit maxBuffer, terminate promptly, preserve context lines, and report omitted/truncated truthfully.

## ARC-05 — Interactive startup suppresses malformed settings errors

**Priority:** P1  
**File:** `src/cli/commands/chat.tsx:164-176`

`readSettings().catch(() => ({}))` converts malformed/invalid settings into an empty configuration. This contradicts the documented and nested-agent contract that malformed settings fail loudly. The user initially sees “unconfigured”; the next turn later fails when request assembly rereads the same malformed file.

**Fix:** Do not substitute `{}` for malformed settings. Distinguish ENOENT (already handled by `readSettings`) from parse/shape errors, display the actionable path-bearing error, and disable model turns/config mutations until the user fixes or opens the file. Keep the UI alive if desired, but do not pretend configuration is empty.

**Acceptance tests:** missing file starts normally; malformed JSON and invalid known fields show the exact actionable error; no model turn starts with fake empty settings; unknown fields remain accepted.

## ARC-06 — Removing the active provider selects the first remaining provider/model

**Priority:** P1  
**File:** `src/cli/commands/providerWizard.ts:76-90`

`providerRemove()` patches `provider` and `model` to `providers[0]`/its first model. This conflicts with the explicit product contract: no default provider/model and no fallback to the first configured option. Although a message announces the switch, the user did not select it.

There is also obsolete logic treating a missing active provider as though the first provider were active, which preserves the old fallback mental model.

**Fix:** When the active provider is removed, clear `provider` and `model`; return to provider/model selection. Preserve the active selection when removing an inactive provider. Add tests asserting no first-item fallback.

## ARC-07 — stdio MCP key setup is accepted but does not persist coherently

**Priority:** P2  
**Files:** `src/cli/commands/wizardPrompts.ts`, `src/cli/commands/mcpWizard.ts`, `src/config/mcpSettings.ts`

The custom stdio flow asks for an API key, attaches `headers` to the stdio server, and reports success. `normalizeServer()` intentionally drops headers for stdio on the next settings read. Depending on the upsert path, the key exists transiently in the write patch and then disappears from configured server state. Standard stdio MCP auth normally belongs in environment variables, which haze does not model.

**YAGNI fix:** Do not ask for a key after stdio command setup. If stdio environment support is not a current product requirement, explicitly state that auth must be handled by the configured command/wrapper. Do not add arbitrary env configuration solely to fix this inconsistency.

## ARC-08 — `ChatScreen` remains an oversized mode/state controller

**Priority:** P1  
**File:** `src/cli/commands/chat.tsx` (1,237 LOC)

The prior simplification review successfully extracted pure wizard calculations, input-buffer logic, and session recorder calls. `ChatScreen` still owns roughly thirty state/ref values and one very long `submit()` dispatch covering every mode, plus settings writes, filesystem deletion, session lifecycle, model turns, task cleanup, and rendering.

The problem is not merely LOC. State transition and side effect remain split: helper returns a `mode/settingsPatch/message`, then component branches independently decide what to clear, persist, refresh, or display. Adding a field to a wizard still touches component orchestration.

**KISS direction:**

1. Introduce one explicit `dispatchModeInput(state, value)` pure transition over wizard draft/selection state.
2. Return a short union of effects (`updateSettings`, `removeSkillDir`, `createSkill`, `startAgentTurn`, `message`).
3. Execute effects in a small boundary function.
4. Leave React state binding and JSX in `ChatScreen`.

Do not build a generic form engine or plugin architecture. Prove the shape with provider and MCP flows before migrating the rest.

## ARC-09 — Recursive retry lifecycle emits contradictory durable events

**Priority:** P1  
**File:** `src/cli/commands/streaming.ts`

On retry/context-overflow recovery, `runAgentTurn` recursively calls itself from `catch`. Each invocation emits `turn_start` and its own `finally` emits `turn_end`. The outer invocation's `turnStatus` remains `failed`, so a successful inner retry can be followed by an outer failed `turn_end` in session events. Headless mode explicitly filters nested `turn_end`, masking rather than fixing the underlying lifecycle. Outer MCP clients also remain open through backoff and the inner attempt.

**Fix:** Split “one model attempt” from “one user turn.” Use a bounded iterative loop owned by the turn:

- emit one `turn_start` and one authoritative `turn_end`;
- create/close MCP resources per attempt;
- retain one abort controller across attempts;
- record retry events between attempts;
- settle busy/session status once.

This will also make ARC-01 easier to fix.

## ARC-10 — Resource limits bind returned text more often than work performed

**Priority:** P2  
**Files:** `src/llm/hazeTools.ts`, `src/core/agent/toolOutputStore.ts`, `src/config/contextFiles.ts`, session/log readers, LSP parser

Examples:

- `readFile` loads the complete file before selecting lines;
- context files are truncated after complete read;
- session restore and log summary read complete, indefinitely growing JSONL files;
- LSP buffers complete declared frames without a maximum;
- raw tool output is count-bounded but not byte-bounded.

The names and docs often say “bounded,” but only the model-facing returned value is bounded. Establish one compact budget module with byte constants and small streaming helpers. Avoid a generic stream framework; target the concrete reads above.

## ARC-11 — One invalid skill can disable the whole skill/request path

**Priority:** P2  
**File:** `src/skills/SkillRegistry.ts`

`loadSkillRegistry` iterates directories but does not isolate `stat`/parse/reference errors per skill. One malformed skill can make interactive refresh fail silently and later make every `assembleRequestContext` fail, even though unrelated skills and built-in tools are valid.

**Fix:** Return `{skills, errors}` like MCP loading does. Skip invalid entries deterministically, show concise per-skill errors in `/skills` or system output, and let turns continue with valid skills. Keep validation strict for the bad skill itself.

## Additional low-priority observations

These are not recommended as immediate projects:

- `commandParts()` cannot represent quoted stdio LSP/MCP arguments or executable paths containing spaces. If real user reports justify it, store command and args as separate wizard fields; do not implement a shell parser.
- `readSessionEntries` and `loadTasks` cast parsed JSON without runtime shape validation. Add tolerant Zod validation when serialized formats next change; no migration framework is needed now.
- The docs site loads Google Fonts and has no CSP. This is a privacy/hardening consideration for the static site, not a core CLI release blocker.
- `tsc --noUnusedLocals --noUnusedParameters` identifies a few unused JSX-era React imports and an unused `StdioLspClient.server` property. Clean these opportunistically, not as a dedicated refactor.

## Test-suite assessment

The 831 passing tests are broad and fast, but several tests currently lock down helpers rather than runtime integration. Highest-value missing tests are:

- authoritative turn status at step/tool limits;
- `{ok:false}` through event/log/headless output;
- retry event ordering;
- ignored direct grep targets;
- symlink escapes for skills and LSP;
- child-process tree cancellation and output memory caps;
- ordered/flushable session persistence;
- MCP discovery timeout/abort;
- private file modes.

Add these before structural refactors. They protect behavior and reduce the need for abstractions.
