# Comprehensive Review Remediation — Retrospective

- Conducted: 2026-07-10
- Feature slug: `comprehensive-review-remediation`

## Outcome

All 19 numbered findings (SEC-01..08, ARC-01..11) from the 2026-07-10 comprehensive review are closed with regression coverage. Independent review (REVIEW.md) accepted; production-readiness assessment (PRODUCTION_READINESS.md) is READY. Full validation passes: typecheck, lint, 871 tests, build, pack dry-run, context report, and `npm audit` (0 vulnerabilities).

## What went well

- **The review framed the right problem.** It explicitly excluded "the model can run commands" as a vulnerability and instead targeted *mismatches between documented guarantees and runtime behavior*. That framing produced actionable, testable findings rather than scope creep into a sandbox/permission-gate system the product deliberately rejects.
- **Test-first remediation worked.** Phase 0 adversarial characterization tests (grep ignored roots, symlink escapes, descendant termination, ordered persistence, MCP abort) locked behavior before refactors, so the structural changes in Phases 1–8 were verifiable rather than hopeful.
- **Cross-cutting primitives reduced duplication (DRY).** Four small shared modules now own the repeated concerns: `config/privateStorage.ts` (permissions + atomic writes), `core/process/runBoundedProcess.ts` (bounded subprocess + tree kill), `core/limits/byteBudgets.ts` (named limits), and `core/persistence/orderedFileWriter.ts` (ordered flushable writes). Each is one focused file with its own contract — no framework, no plugin architecture, no DI.
- **The hardest refactor (turn lifecycle) landed cleanly.** Splitting `runAgentTurn` into a turn coordinator (one `turn_start`/`turn_end`, iterative retry, one abort controller) and a per-attempt function (own MCP clients, own resources) fixed ARC-01/02/09 together and made status authoritative across UI, events, logs, sessions, and headless exit codes.
- **Dead code was removed, not preserved.** The `completionDecision` heuristic policy was tested but unwired (ARC-01); it was deleted and replaced with the smaller, wired `terminalTurnStatus`, rather than kept as "in case we need it."

## What to improve

- **Tested-but-unwired abstractions are a recurring failure mode.** The most serious finding (ARC-01) was a completion policy with passing tests that protected no runtime behavior. When adding a policy/decision module, wire it into the caller in the same change and add an integration test that proves the wire exists — a unit test of an unused function proves nothing. Audit existing "policy" modules for the same gap.
- **Bound work performed, not just returned text.** Several "bounded" paths only bounded the model-facing return value while loading entire files/streams into memory first (ARC-10, SEC-02). The lesson: a limit that runs *after* the resource is resident is not a limit. The `core/limits` + `core/io` split makes this explicit going forward; keep new collectors bounding during collection.
- **Status/result/event translation must be single-sourced.** ARC-02 was one tool result translated three different ways (UI error, but session/log/headless said success). Derive the structured `ok` once and fan it out; never re-derive truth per consumer.
- **Cancellation must mean the whole tree.** Killing only the shell PID (SEC-03) lets descendants outlive the reported timeout/abort. Default to process-group termination with SIGTERM→SIGKILL escalation for any spawned subprocess.
- **Don't let optional integrations hang the core path.** MCP/LSP/skills are optional; one bad server or skill must not block every turn or disable built-ins (SEC-07, ARC-11). Default to per-component timeouts, isolation, and `{results, errors}` returns.
- **Sandbox limitations masked real validation.** The implementation environment could not start the localhost-binding webFetch tests or reach the npm registry, so its "855 tests / audit pending" understated true green. Re-run the full suite and audit on an unrestricted machine before declaring done (done here in REVIEW/PRODUCTION_READINESS).
- **Doc drift follows code deletion.** Removing `completionDecision` left `AGENTS.md` describing capabilities the module no longer had. When deleting a module/contract, grep docs and nested AGENTS.md files for its name in the same change.

## Process notes for future remediations

- Ordering by "close false guarantees and high-impact security gaps before maintainability" (the plan's Phase order) was correct: ARC-08 (ChatScreen simplification) was deliberately last and scoped to provider/MCP flows, avoiding a framework build-out the plan warned against.
- One agent owning both Phase 2 (private storage) and Phase 6 (ordered persistence) was efficient because the same call sites were touched; the plan explicitly permitted this and it held.
- Keeping changes additive (status union stayed `complete|aborted|failed`) avoided a cascading README/event/exit-code documentation rewrite. The `partial` status was correctly rejected as YAGNI.

## Artifacts

- Findings: `docs/code-review/2026-07-10-{comprehensive-review,security-findings,architecture-findings,remediation-plan}.md`
- Workflow: `REQUEST.md`, `RESEARCH.md`, `PLAN.md`, `IMPLEMENTATION.md`, `REVIEW.md`, `PRODUCTION_READINESS.md`, `STATUS.md`, this file.
