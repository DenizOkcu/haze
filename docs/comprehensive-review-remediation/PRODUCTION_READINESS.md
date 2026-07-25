# Comprehensive Review Remediation — Production Readiness

- Assessed: 2026-07-10
- Assessor: independent Pi session (same as REVIEW.md)
- Verdict: **READY** — all 19 findings closed, full validation green, no intentional deferrals. Remaining work is release mechanics (commit, version bump, merge), not correctness.

## Definition of Done (from remediation plan) — all met

| Criterion | Status | Evidence |
|---|---|---|
| All P0/high findings have regression tests and fixes | MET | REVIEW.md verifies SEC-01..08 + ARC-01/02; 871 tests pass |
| Timed-out/aborted command cannot leave descendants running | MET | `runBoundedProcess` process-group kill + `runBoundedProcess.test.ts` descendant test (SEC-03) |
| Tool processing has hard byte budgets before output is resident | MET | `core/process`, `core/io`, `core/limits`, `toolOutputStore` per-entry+aggregate budgets (SEC-02/ARC-10) |
| File/skill/LSP boundaries hold under symlinks and ignored direct targets | MET | `assertRealPathInsideRoot` reused across tools/skills/LSP/registry; grep ignored-root rejection (SEC-04/05/06) |
| Home-state secrets/transcripts are private by default | MET | `privateStorage.ts` `0700`/`0600` + opportunistic tightening (SEC-01) |
| One hanging MCP server cannot block a turn indefinitely | MET | per-server deadlines, bounded concurrency, abort-aware, bounded cleanup (SEC-07) |
| Public tool and turn statuses agree with UI/work-state reality | MET | single `ok` calc; `terminalTurnStatus` once per turn; headless exit mirrors status (ARC-01/02) |
| Sessions/logs flush in order | MET | `OrderedFileWriter` + session recorder promise chain + `flush()` at turn/session/shutdown (ARC-03) |
| No active provider/model invented after removal or malformed settings | MET | removal clears selection; malformed settings surfaced and blocking (ARC-05/06) |
| Full validation and package dry run pass | MET | see Validation below |

## Validation (re-run for this assessment)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 97 files, 871 tests |
| `npm run build` | PASS |
| `npm pack --dry-run` | PASS — 255 files, 196.1 kB package, 1.2 MB unpacked |
| `npm run context:report` | PASS — logical input estimate 1,145 tokens, no duplicate context groups |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |

All seven Phase-9 checks pass on the development machine, including the 3 `tests/llm/webFetch.test.ts` localhost-binding transport tests and the network-backed `npm audit` that the implementation sandbox could not run.

## Known residuals (non-blocking, from REVIEW.md)

1. **Resolved during this pass:** `src/core/goal/AGENTS.md` no longer claims `completionPolicy.ts` provides "completion decisions"; it now points to `turnOutcome.ts`.
2. **Optional:** no dedicated *oversized*-LSP-frame test (the shared reject/kill path is covered via malformed-header/JSON cases). Low risk.
3. **Acknowledged:** `grepRunner` buffers `maxMatches+1` before stopping by design (early stop), with the exact cap applied downstream and `matchCountIsLowerBound` reported truthfully.

None block release. Items 2–3 can ship as follow-ups.

## Release mechanics (not correctness)

- The branch `fix/comprehensive-review-findings` is fully uncommitted (74 paths). Commit before merge.
- `CHANGELOG.md` has an `Unreleased` entry covering the security and correctness changes; `README.md` and `docs/index.html` document status semantics, credentialed-HTTP policy, ignored grep override, integration timeouts, and private storage. Nested `AGENTS.md` files (12 updated, 4 new) are aligned with the new modules and contracts.
- Version bump: the changes are security/correctness hardening with one small public refinement (status is stricter — turns that previously reported `complete` at a budget now report `failed`). Recommend `0.9.0` (behavioral change to documented status semantics) rather than a patch; `0.8.1` is defensible if the project treats "previously-buggy complete" as not-a-guarantee.
- Documentation is complete for changed behavior; no `partial` status value was added (the chosen decision in PLAN.md).

## Recommendation

Ship it. Commit, bump to `0.9.0`, merge. Treat residual notes 2–3 as optional hardening follow-ups.
