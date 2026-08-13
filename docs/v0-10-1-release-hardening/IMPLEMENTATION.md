# v0.10.1 Release Hardening Implementation

All PLAN.md items (RH-001 through RH-011) are implemented. Work proceeded from clean HEAD after stashing a non-compiling intermediate hand-off (preserved via `git stash`).

## Changed files

### New product source

- `src/llm/tools/gitIgnore.ts` — bounded batched `git check-ignore -z --stdin` classifier (RH-001).
- `src/core/agent/toolExecutionBudget.ts` — atomic execution-boundary budget wrapper shared by main + subagent (RH-003).
- `src/core/deadline.ts` — `withToolDeadline` (with late-settlement quarantine) + `createAbsoluteDeadline` (RH-004).
- `src/cli/commands/ndjsonSink.ts` — ordered, backpressure-aware NDJSON sink (RH-006).
- `scripts/verify-release-metadata.mjs` — read-only version-consistency verifier (RH-011).

### Modified product source

- `src/utils/fs.ts` — `walkDir` gains `ignoreBatch` + cursor pre/branch/post split (RH-001).
- `src/llm/tools/fileToolShared.ts`, `src/llm/hazeTools.ts`, `src/cli/chat/fileMentionSuggestions.ts` — use the batch classifier (RH-001).
- `src/core/subagent/subagentRunner.ts` — uses the shared execution-budget wrapper (RH-003).
- `src/cli/commands/streaming.ts` — global/slice execution budgets; layered deadlines; model-aware context budgeting + prepareStep compaction; budget/deadline result handling; absolute turn deadline (RH-003/004/005).
- `src/llm/lsp.ts`, `src/llm/lspTools.ts`, `src/llm/requestContext.ts`, `src/cli/commands/streaming.ts`, `src/cli/chat/contextReport.ts` — `LspPool` turn-scoped reuse (RH-009).
- `src/core/subagent/subagentCoordinator.ts` — bounded read-only bypass (RH-010).
- `src/cli/chat/sessionRecorder.ts` — snapshot coalescing + skip `message_update` (RH-006/008).
- `src/ui/components/MarkdownText.tsx` — bounded LRU root-chunk cache (RH-007).
- `src/core/agent/contextBudget.ts`, `src/config/settings.ts`, `src/llm/client.ts`, `src/cli/chat/sessionLifecycle.ts` — model-aware budget + optional `modelLimits` metadata (RH-005).
- `src/core/agent/budgets.ts`, `src/core/agent/events.ts` — deadline constants + `timeout` event phases.
- `src/cli/index.ts`, `src/cli/commands/runCommand.ts` — `--timeout`, parser, sink wiring, delta updates (RH-004/006).
- `vitest.config.ts` — `maxWorkers: 4` (RH-002). `package.json` — `release:verify` + prepublishOnly.

### Tests added/updated

`tests/hazeTools/gitIgnore.test.ts`, `tests/utils/fs.test.ts`, `tests/hazeTools/listFiles.test.ts`, `tests/core/toolExecutionBudget.test.ts`, `tests/core/deadline.test.ts`, `tests/core/contextBudget.test.ts`, `tests/config/settings.test.ts`, `tests/llm/lspPool.test.ts`, `tests/core/subagent/subagentCoordinator.test.ts`, `tests/cli/chat/sessionRecorder.test.ts`, `tests/cli/messages.test.tsx`, `tests/cli/commands/ndjsonSink.test.ts`, `tests/cli/commands/runCommand.test.ts`.

## Summary by finding

- **RH-001** — One `git check-ignore` batch per directory level; cursor resume skips pre-cursor subtrees entirely. O(visited dirs) subprocesses, not O(entries).
- **RH-002** — `maxWorkers: 4`; three consecutive canonical runs green. No production timeout changed.
- **RH-003** — `withToolExecutionBudget` checks both a turn-wide and a per-slice state synchronously at execute; a parallel batch cannot overshoot either. Blocked calls return a structured result with no side effect and force text-only synthesis next step.
- **RH-004** — Per-tool deadline wrapper (10m default, 20m subagent) quarantines late settlement; absolute turn deadline (30m default, `--timeout` override) aborts the turn; phase-specific `timeout` events (`turn`/`tool`/`model-stream`).
- **RH-005** — `calculateRequestTokenBudget` = context window − system − tool schemas − output reserve − safety margin; optional `modelLimits` per provider/model; prepareStep re-compacts accumulated history; overflow retries shrink the target (0.6×).
- **RH-006** — `message_update` emitted as deltas via `messageUpdateDelta`; ordered `NdjsonSink` awaits drain and flushes before the terminal result; `message_end.text` authoritative; `message_update` skipped in the persistence writer.
- **RH-007** — `markdownRootChunks` memoized in a bounded LRU (500); repeated partitioning of settled Markdown adds zero `marked.lexer` calls.
- **RH-008** — At most one `conversation_snapshot`/`work_state_snapshot` in flight; newer snapshots replace a pending one before disk.
- **RH-009** — `LspPool` reuses one initialized client + opened documents per server per turn; evicts terminated clients; bounded teardown in the caller's finally.
- **RH-010** — Read-only bypass up to `maxConcurrency − 1` behind a blocked mutation head; serialized mutations always retain a free slot (no starvation, no overlap).
- **RH-011** — `scripts/verify-release-metadata.mjs` validates package/lockfile/README/changelog/SECURITY/docs/AGENTS agreement in one run; exits non-zero on mismatch; wired into `prepublishOnly`.

## Validation outcomes

- `npx tsc --noEmit` — exit 0.
- `npm run lint` — clean.
- `npm run build` — exit 0.
- `./scripts/check-agents-stamps.sh` — fresh.
- `npm run release:verify` — consistent.
- `npm audit --audit-level=high` — 0 vulnerabilities.
- Full suite, three consecutive `npx vitest run` runs: 1364/1364 each (~21.6s).

## Notes / risks

- The stashed non-compiling intermediate hand-off is preserved but superseded; do not reconcile it.
- Token estimates remain approximate (chars/token + image estimate); explicit `modelLimits` is safer than the old fixed 40K but cannot guarantee provider-tokenizer exactness.
- Deadline wrappers cannot physically stop arbitrary third-party code that ignores abort; they guarantee bounded logical settlement and quarantine late state changes.
- `stream-json` `message_update` is now delta-based: consumers that read cumulative `message_update.text` must reconstruct from `delta`/`offset` or use `message_end.text`.
