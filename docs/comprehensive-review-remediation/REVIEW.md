# Comprehensive Review Remediation — Independent Review

- Reviewed: 2026-07-10
- Reviewer: independent Pi session (fresh, not the implementation agent)
- Scope: verify every SEC-01..SEC-08 and ARC-01..ARC-11 finding against the actual uncommitted diff on branch `fix/comprehensive-review-findings` (base `844cf6c`, the 0.8.0 release).
- Method: read each finding's contract in `docs/code-review/*`, then read the implementing source and its tests, and assert the stated acceptance criteria are met in code and in tests. Re-ran the full confidence suite and the previously network-blocked audit.

## Verdict

**ACCEPT.** All 19 numbered findings are implemented and have regression coverage that exercises the acceptance criteria. No finding is deferred. Three minor, non-blocking observations are listed under Residual notes; none block merge after they are addressed or acknowledged.

## Validation (re-run by this review)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 97 files, 871 tests |
| `npm run build` | PASS |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities (clears the sandbox-blocked item from IMPLEMENTATION.md) |

Note: the dev environment ran the full suite including the 3 `tests/llm/webFetch.test.ts` localhost-binding transport tests that the implementation sandbox could not start (97 files / 871 tests vs. the implementation report's 96/855 with webFetch excluded).

## Finding-by-finding assessment

### SEC-01 — Private home-state permissions (High) — PASS

Helper `src/config/privateStorage.ts` centralizes `ensurePrivateDir` (`0700`), `writePrivateFileAtomic`/`writePrivateJsonAtomic` (`0600`, temp+fsync+rename, temp cleanup in `finally`), `appendPrivateFile`, and `tightenPrivateFile`. All `~/.haze` state migrated: `settings.ts`, `inputHistory.ts`, `updateCheck.ts` (all use `writePrivateJsonAtomic` + `tightenPrivateFile` on existing files), `sessionStore.ts`, `llmLog.ts` (`appendPrivateFile` + `ensurePrivateDir`). Workspace `.haze/tasks.json` correctly left untouched. `tests/config/privateStorage.test.ts` asserts `0700`/`0600` modes, no leftover `.tmp`, tightening of pre-existing `0644` files, and skips mode assertions on Windows. Matches every acceptance test.

### SEC-02 — Output memory exhaustion (High) — PASS

`src/core/process/runBoundedProcess.ts` bounds stdout/stderr independently during collection via a head/tail `collector` (limit configurable, `BASH_STREAM_BYTES`/`PROCESS_STDERR_BYTES`). `toolOutputStore.ts` enforces per-entry (`TOOL_OUTPUT_ENTRY_BYTES`, UTF-8-safe prefix walkback) and aggregate (`TOOL_OUTPUT_TOTAL_BYTES`, LRU eviction) byte budgets. `readFile` streams via `readUtf8LinesPage`; `editFile`/`replaceLines` use `readUtf8Prefix` with `EXACT_MUTATION_BYTES` and reject larger files with `file_too_large`. `runBoundedProcess.test.ts` asserts independent stream bounds, retained/omitted byte metadata, and valid UTF-8 at a mid-character truncation. Acceptance criteria fully covered.

### SEC-03 — Process-tree termination (High) — PASS

`runBoundedProcess` spawns `detached` on POSIX and signals the group via `process.kill(-pid, SIGTERM)` with `killGraceMs` escalation to `SIGKILL`; Windows uses `taskkill /pid <pid> /T /F` on the force phase. Resolves exactly once across `close`/`error`/timeout/abort. Reports `signal`, `timedOut`, `aborted`, `forced`. `bashTool` forwards `context.abortSignal` and exposes `aborted`, `signal`, `forcedTermination`. Test `'terminates descendants in the child process group'` spawns a grandchild writing a pid file, times out, and polls until the grandchild is no longer signalable — it is gone. Matches acceptance.

### SEC-04 — `grep` ignored bypass (High) — PASS

`grep` now uses `prepareWorkspaceRead(searchPath, includeIgnored)` (shared with `readFile`), which runs `assertNotIgnored` then `assertRealPathInsideWorkspace`. Schema gained `includeIgnored: z.boolean().default(false)`, wording aligned with `readFile`/`listFiles`. `tests/hazeTools/grep.test.ts` asserts a directly named ignored file and directory both yield `{ok:false, reasonCode:'ignored_path'}` by default and succeed only with explicit `includeIgnored:true`.

### SEC-05 — Skill reference symlink escape (High) — PASS

`SkillLoader.ts` resolves real paths for both the skill root and each candidate via `assertRealPathInsideRoot(dir, candidate, ..., 'skill directory')`, applied to `SKILL.md` and every reference. `SKILL.md` bounded at `SKILL_MARKDOWN_BYTES` (256 KB), references at 50 KB via `readUtf8Prefix`. `SkillRegistry.ts` additionally confines each skill directory to the real skills root. Tests assert `../` reference rejection (`/escapes/`) and an outside-root symlinked `SKILL.md` rejection (`/outside the skill directory/`). Matches acceptance.

### SEC-06 — LSP workspace/return boundary + frame caps (Medium) — PASS

`withLsp` calls `prepareWorkspaceRead(filePath, false)` so opened documents are real-path-confined and ignore-checked; `openDocument` bounds at `LSP_DOCUMENT_BYTES`. `onData` enforces `LSP_HEADER_BYTES`, `LSP_FRAME_BYTES`, and `LSP_BUFFER_BYTES`; overflow or missing `Content-Length` throws `LspError`, the constructor's stdout handler calls `rejectAll` and `SIGTERM`s the child (terminates client, rejects pending). Returned locations: `locationToWorkspaceResult` runs `assertRealPathInsideWorkspace` on the returned `file://` path and rewrites escapes to `{path: uri, external: true}`. Tests cover the external-symlink label, malformed-header rejection, malformed-JSON rejection, timeout, child-exit, and child-error reject-all paths. Matches acceptance.

### SEC-07 — MCP hang/abort (High) — PASS

`mcp.ts` wraps per-server create+tools() in a `timeout()` that accepts the turn abort signal (`MCP_DISCOVERY_TIMEOUT_MS`), loads servers concurrently via `mapConcurrent` with `MCP_DISCOVERY_CONCURRENCY=4`, closes partial/late clients on error/timeout, and bounds cleanup via `closeMcpClients` (`MCP_CLOSE_TIMEOUT_MS`). Abort is checked before each worker starts and the signal listener rejects promptly. `tests/llm/mcp.test.ts` asserts a hanging server times out while another loads, the failing server's client is closed exactly once, and abort stops discovery promptly. Matches acceptance.

### SEC-08 — Credentialed plaintext HTTP (Medium) — PASS

`endpointSecurity.ts` exports `assertCredentialedEndpointSecure(url, credentials)` which rejects `http:` + credentials + non-loopback hostname while preserving loopback (`localhost`, `.localhost`, `::1`, `127.0.0.0/8`). Wired at configuration time in `providerFinishAdd`, `providerSetKey`, `finishMcpCustomResult`, `setMcpServerKeyResult`, and at runtime in `createMcpClient`. Tests (`tests/config/endpointSecurity.test.ts`) cover loopback HTTP permitted with a key, remote HTTP+key rejected, HTTPS unchanged.

### ARC-01 — Authoritative turn status (P0) — PASS

`streaming/turnOutcome.ts` `terminalTurnStatus` returns `failed` when aborted/error, last tool `ok===false`, budget reached (`finishReason==='length'`/step/tool/tool-only limits), or tools ran with no substantive final text; `complete` only with substantive assistant text and no disqualifier. `runAgentTurn` computes `budgetReached` from actual completed counters and the finish reason, then calls it once. Headless `runHeadless` returns `status === 'complete' ? 0 : 1` and the `result`/`turn_end` NDJSON carry the same status. Test `'cannot report complete after the hard step budget is reached'` (64 steps) asserts `{status:'failed'}`; integration test asserts `turn_end` and `result` both `status:'failed'`. Matches acceptance.

### ARC-02 — Structured tool failure honesty (P0) — PASS

`runAgentAttempt` computes `const ok = toolOutputOk(part.output, true)` once per `tool-result` and uses it for the UI item status, the `tool_end` event `success`, the debug-log `toolResult.success`, work-state observation, and (via `lastToolOk`) the terminal status. `tool-error` sets `success:false` and `lastToolOk=false`. Test `'publishes structured tool failure consistently to events, logs, work state, and status'` asserts all four sinks report `success:false`/failed validation and the outcome is `failed`. Matches acceptance exactly.

### ARC-03 — Ordered, flushable persistence (P1) — PASS

`OrderedFileWriter<T>` (`src/core/persistence/orderedFileWriter.ts`) is a promise-chain preserving invocation order, capturing the first error, exposing `flush()`/`close()`/`error()`. `createSessionRecorder` keeps its own per-session promise chain with `flush()`/`error()` (binding each entry to the session active at invocation time). `llmLog` writes through `OrderedFileWriter` + `appendPrivateFile`. `chat.tsx` awaits `sessionRecorder.flush()` and `endLlmLog` at turn end, clear, compact, and shutdown, surfacing failures via `showPersistenceWarning` instead of swallowing. Matches the "one ordered append queue per open file; flush at turn/session/log end; surface the first failure once" direction. No DB/event-sourcing introduced.

### ARC-04 — True global grep cap (P1) — PASS

`grepRunner.ts` spawns ripgrep, parses `--json` incrementally, and stops after `matches > maxMatches` (a true global count, not per-file) plus separate byte caps (`GREP_STREAM_BYTES`, `PROCESS_STDERR_BYTES`, `TEXT_LINE_BYTES` per line), with timeout/abort and SIGTERM→SIGKILL escalation. The tool reports `matchCountIsLowerBound: result.capped`. This removes the `execFile` maxBuffer failure mode. `tests/hazeTools/grep.test.ts` covers the global cap and capped reporting.

### ARC-05 — Malformed settings surfacing (P1) — PASS

`chat.tsx` no longer substitutes `{}` on error: `readSettings().then(value => ({value, error: undefined})).catch(error => ({value: {}, error: ...}))`, and a `settingsError` state blocks turns and config mutations until the file is repaired (re-read on retry). ENOENT is still handled inside `readSettings`, so a missing file starts normally. Matches acceptance.

### ARC-06 — Active provider/model removal (P1) — PASS

`providerRemove` clears `provider` and `model` to `undefined` only when the active provider is removed (`wasActiveProvider`); inactive removal preserves selection. `providerRemoveModels` clears `model` only when the active model is removed (`wasActive`). The obsolete "first provider as active" fallback is gone. `tests/cli/providerWizard.test.ts` asserts no first-item fallback.

### ARC-07 — stdio MCP key incoherence (P2) — PASS

stdio setup no longer asks for or persists HTTP headers: `finishMcpCustomResult` builds a stdio server without headers, and `selectMcpActionResult`/`setMcpServerKeyResult` return a clear "Stdio MCP authentication must be handled by its command or wrapper" message for stdio. No arbitrary env configuration was added (YAGNI respected).

### ARC-08 — `ChatScreen` transition boundary (P1) — PASS

`wizardTransition.ts` introduces pure `transitionProviderField`/`transitionMcpField` returning a small typed effect union (`provider-draft`/`mcp-draft`/`finish-mcp-stdio`/`mode`/`message`), with dedicated `tests/cli/wizardTransition.test.ts`. `chat.tsx` consumes the effects in a boundary, shortening `submit()`. No generic form engine or plugin architecture was introduced. The implementation stopped at the provider/MCP flows as the plan permitted.

### ARC-09 — Retry/attempt lifecycle (P1) — PASS

`runAgentTurn` is now a bounded `while` loop over `runAgentAttempt`; it emits exactly one `turn_start` and one authoritative `turn_end`, holds one `AbortController` across attempts, and each attempt creates and (in `finally`) closes its own MCP clients. Retries/context-overflow recovery return a `retry` descriptor consumed by the loop instead of recursing. Test `'retries a retryable error up to maxRetries with backoff'` asserts exactly one `turn_start` and one `turn_end`; the MCP-cleanup test asserts `closeMcpClients` runs per attempt. Matches acceptance.

### ARC-10 — Byte budgets on work, not just returned text (P2) — PASS

`src/core/limits/byteBudgets.ts` centralizes all limits. Bounded readers (`boundedRead.ts`: `iterateBoundedUtf8Lines`, `readUtf8LinesPage`, `readUtf8Prefix`) and the bash/grep/LSP collectors bound work performed, not only model-facing text. Session/log readers and context files now consume bounded line/prefix readers. No generic stream framework introduced.

### ARC-11 — Invalid skill isolation (P2) — PASS

`SkillRegistry` returns `{skills, errors}`, iterates directories in sorted order, wraps each in try/catch, records per-directory errors (including duplicate-name "first valid wins"), and lets valid skills + built-ins remain usable. `loadSkillRegistry`'s errors surface to the request context and `/skills`. `tests/skills/SkillRegistry.test.ts` covers invalid/duplicate isolation.

## Residual notes (non-blocking)

1. **Doc drift in `src/core/goal/AGENTS.md`.** It still states `completionPolicy.ts` "provides ... completion/continuation decisions." The `completionDecision`/heuristic functions were removed (correctly — they were dead code per ARC-01); turn outcome now lives in `src/cli/commands/streaming/turnOutcome.ts`. Update the AGENTS.md line to reference only the two retained prompt helpers and point to `turnOutcome.ts`.
2. **No explicit oversized-LSP-frame test.** SEC-06's implementation enforces `LSP_FRAME_BYTES`/`LSP_BUFFER_BYTES` and the shared `rejectAll`+kill path is tested via the malformed-header and malformed-JSON cases, but there is no test asserting an *oversized* frame specifically. The code path is identical, so risk is low; add one assertion for completeness when convenient.
3. **Grep global cap is `maxMatches+1` tolerant.** `grepRunner` stops after `matches > maxMatches`, having already buffered the match that exceeded, then the downstream `parseRipgrepJsonStream` applies the final exact cap. This is intentional (it stops early rather than buffering the whole repo) and `matchCountIsLowerBound`/`truncated` are reported truthfully. Behavior is correct; noting the off-by-one buffering so it is not mistaken for a bug later.

None of the above are findings reopened; all are hardening/docs.

## Recommendation

Proceed to G5/G6: address residual note 1 (doc) before merge, treat 2–3 as optional follow-ups, then run the Phase-9 documentation/version pass and merge or split into reviewable PRs. The branch is safe to commit in its current state.
