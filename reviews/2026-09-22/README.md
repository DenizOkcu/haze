# haze architecture and code review — 2026-09-22

**Baseline:** commit `b53d4e90352a1283c4d05280017760424fd4580b`, package **1.2.1**.

**Outcome:** 33 actionable findings: **12 P1**, **20 P2**, **1 P3**. No P0 finding was established. Implementation, tests, package metadata, and generated output were not changed; this directory is a fix-later handoff.

This is a repository-wide architectural review with targeted deep source reads, local validation, and safe helper reproductions—not a claim that every line has been audited or every possible defect found. Findings distinguish reproduced behavior, source-traced defects, and reliability risks. In particular, secret-related findings were not exercised against real credentials.

## Start here: highest-risk findings

1. **Secret boundaries are inconsistent across tools:** bulk-replacement previews (TS-01), grep traversal (TS-07), and skill references (CI-03) bypass parts of the shared protection. Task-state symlinks can escape workspace confinement (CI-05).
2. **Completion evidence can be false or disappear:** validation ordering (AR-01), missing mutation accounting (AR-02), masked artifact commands (AR-03), and relaunch state loss (AR-04).
3. **Durable/UI lifecycle can lose work:** resumed-goal crash frontier (SU-01) and asynchronous manual compaction overwriting newer state (SU-03).
4. **Integration validation is incomplete:** provider discovery can send draft keys over remote HTTP (CI-01); malformed LSP ranges can silently edit the wrong location (TS-05).

## Reports

| Report | Focus |
| --- | --- |
| [agent-runtime.md](agent-runtime.md) | Completion evidence, retries/resume, deadlines, worker result integrity |
| [tools-safety.md](tools-safety.md) | File/secret boundaries, search, bulk edits, LSP mutation safety, output reduction |
| [config-integrations.md](config-integrations.md) | Provider setup, LSP diagnostics, skills, aggregate input limits, task storage |
| [state-cli-ui.md](state-cli-ui.md) | Session recovery/clear, compaction, resume UX, headless output, mention completion |
| [maintenance-release.md](maintenance-release.md) | Release gates, build/test determinism, package artifacts, provenance, KISS/DRY/YAGNI |
| [validation.md](validation.md) | Commands actually run, exact baseline failures, safe reproductions, exclusions |

## Prioritized fix backlog

All items are **open**. IDs are unique within this review, not GitHub issue numbers.

| ID | Priority | Finding | Report |
| --- | --- | --- | --- |
| AR-01 | P1 | Validation reruns use insertion order instead of execution order | [Runtime](agent-runtime.md) |
| AR-02 | P1 | Bulk/LSP/delegated mutations bypass work-state validation debt | [Runtime](agent-runtime.md) |
| AR-03 | P1 | Newline/background commands count as direct artifact validation | [Runtime](agent-runtime.md) |
| AR-04 | P1 | Headless relaunch discards structured completion obligations | [Runtime](agent-runtime.md) |
| AR-05 | P2 | Idle-stall relaunch can duplicate the original request | [Runtime](agent-runtime.md) |
| AR-06 | P2 | Cleared deadlines still fire and tool abort listeners remain | [Runtime](agent-runtime.md) |
| AR-07 | P2 | recordCompaction bypasses abandoned-attempt quarantine | [Runtime](agent-runtime.md) |
| AR-08 | P2 | Failed workers lose confirmed changed-path/validation records | [Runtime](agent-runtime.md) |
| TS-01 | P1 | Bulk-replacement scan reads protected descendants before guards | [Tools](tools-safety.md) |
| TS-02 | P2 | grep includeIgnored does not affect subprocess traversal | [Tools](tools-safety.md) |
| TS-03 | P2 | Empty cursor reports an empty repository | [Tools](tools-safety.md) |
| TS-04 | P2 | Regex replacement loses lookaround/original-input context | [Tools](tools-safety.md) |
| TS-05 | P1 | Malformed LSP ranges are coerced into edits | [Tools](tools-safety.md) |
| TS-06 | P2 | Semantic reducers misread mixed-command output | [Tools](tools-safety.md) |
| TS-07 | P1 | grep descendant exclusions diverge from targeted secret guards | [Tools](tools-safety.md) |
| TS-08 | P2 | Multi-file writes do not report partial mutation effects | [Tools](tools-safety.md) |
| CI-01 | P1 | Provider discovery sends credentials before endpoint validation | [Integrations](config-integrations.md) |
| CI-02 | P2 | Wrong LSP pull-diagnostic names produce false empty diagnostics | [Integrations](config-integrations.md) |
| CI-03 | P1 | Skill reference loading omits secret-file protection | [Integrations](config-integrations.md) |
| CI-04 | P2 | Discovery/skill per-item caps leave aggregate allocation unbounded | [Integrations](config-integrations.md) |
| CI-05 | P1 | Task-state symlinks bypass workspace-local storage boundary | [Integrations](config-integrations.md) |
| SU-01 | P1 | Earlier goal_end invalidates a later same-ID crash frontier | [State/UI](state-cli-ui.md) |
| SU-02 | P2 | Clear does not durably reset restored conversation | [State/UI](state-cli-ui.md) |
| SU-03 | P1 | Manual compaction can hang or overwrite newer conversation | [State/UI](state-cli-ui.md) |
| SU-04 | P2 | Recovery slash commands discard the paused-goal checkpoint | [State/UI](state-cli-ui.md) |
| SU-05 | P2 | NDJSON producer queue/output-failure handling is incomplete | [State/UI](state-cli-ui.md) |
| SU-06 | P2 | Mention completion can offer stale-token results | [State/UI](state-cli-ui.md) |
| MR-01 | P2 | Release metadata verifier fails and is absent from CI | [Maintenance](maintenance-release.md) |
| MR-02 | P2 | Default suite depends on stale local dist state | [Maintenance](maintenance-release.md) |
| MR-03 | P2 | CI uploads a tarball that dry-run never creates | [Maintenance](maintenance-release.md) |
| MR-04 | P2 | Release verifier converts file URLs incorrectly | [Maintenance](maintenance-release.md) |
| MR-05 | P2 | Duplicated Git readers mishandle gitdir/worktree layouts | [Maintenance](maintenance-release.md) |
| MR-06 | P3 | Ten unused exports need intentional triage | [Maintenance](maintenance-release.md) |

### Priority definitions

- **P0:** established critical, broad-impact emergency. None established here.
- **P1:** repair promptly: safety boundary, silent corruption/lost work, or falsely authoritative autonomous completion under a concrete scenario.
- **P2:** meaningful correctness/reliability or contributor-workflow defect/risk, narrower impact or trigger.
- **P3:** maintainability/tooling cleanup; do not prioritize over correctness.

A priority is not a security severity score. Source-traced findings must gain a focused regression reproduction before implementation, especially medium-confidence UI behavior.

## Suggested sequencing and ownership

1. **Safety batch:** TS-01 + TS-07 + CI-03 + CI-05; fix CI-01 independently. Establish one shared policy boundary. Land secret-exclusion parity before enabling wider grep traversal in TS-02.
2. **Evidence batch:** AR-01 + AR-02 + AR-03, then AR-08/TS-08. Avoid separate incompatible mutation projections in each tool.
3. **Continuation batch:** AR-04 + AR-05 + SU-01 + SU-04. Treat task counts, mutation debt, validation status, and unresolved red-check identity as one goal-scoped continuation contract.
4. **Lifecycle batch:** AR-06 + AR-07 + SU-02 + SU-03 + SU-05. Keep cleanup ownership explicit and bounded.
5. **Tool correctness:** TS-03 + TS-04 + TS-05 + TS-06 + CI-02; keep safety and evidence regression tests alongside changes.
6. **Maintenance:** MR-01 through MR-06; CI-04 and SU-06 receive focused resource/interaction tests. Do not bulk-refactor orchestration just to reduce line counts.

Independent batches can run in parallel; findings sharing workState, session restoration, or toolContext should have one owner or be serialized.

## Required handoff discipline for fixing agents

- Read current scoped AGENTS guidance and re-check referenced code: these line numbers refer to the baseline, not a permanent API.
- Reproduce the finding in an isolated fixture; distinguish an accepted limitation from a broken contract.
- Apply the smallest fix. No source changes were authorized by this review request; future implementation requires its own task.
- Add a failing desired-behavior regression and make it green where practical. The review's reproduction assertions deliberately demonstrate current incorrect behavior.
- Preserve unrelated worktree changes, explicit provider/model selection, shell freedom, context isolation, and hard secret protection. Do not test against actual home credentials.
- Run focused tests, then the relevant typecheck/lint/full suite. Record command outcomes, not prose claims of success.
- Update the finding's status with commit, tests, and any residual limitation; do not erase the original evidence.

## Coverage and limits

| Area | Review depth / evidence |
| --- | --- |
| Repository structure and public contracts | Tracked-file inventory, scoped guidance, package scripts, CI and release verifier; largest source files identified |
| Agent core and supervision | Deep reads of completion/work state, goal policy, supervisor, result observation, deadline/quarantine and worker coordination; seven helper defect families reproduced |
| File tools and filesystem safety | Deep reads of catalog/search/listing, bulk replacement, tool coordination, workspace guards, secret policy, walker and LSP edits |
| Processes and network | Bounded subprocess primitive and web-fetch bounded-read/extraction path inspected; existing tests executed; not an exhaustive SSRF/DNS/process escape audit |
| Providers/configuration/integrations | Client selection, discovery, endpoint policy, settings persistence, OAuth fetch adapter, MCP discovery, LSP client/requests, skills and task storage inspected |
| Session/UI/headless | Restoration/frontier, recorder, slimming, lifecycle, chat submission/resume, headless relaunch/NDJSON and mention suggestions inspected |
| Presentation | UI guidance, semantic ChatScreen navigation and selected input paths; rendering/theme/input tests ran, but not every rendering branch or theme palette manually reviewed |
| Tests/build/release | Full local suite, typecheck, ESLint, Knip, release metadata and launcher checked; fixture gaps identified; no rebuild or package-install smoke test |
| Docs/scripts/benchmarks/spec-kit | CI/package/release-script consistency reviewed and metadata verifier covered doc stamps; benchmark agents, all static-site JS/HTML, spec-kit helpers and every auxiliary script were not deeply audited |

No blanket “no issues” conclusion applies to uninspected code. Remaining assurance work includes live-provider retry behavior, standards-compliant LSP servers, terminal concurrency/resize sessions, long-session memory pressure, full OAuth/account-switch races, supported Node versions, Windows, benchmark harnesses, and source not deeply read in this pass. Those are coverage limits, not invented defects.

The repository has strong foundations: focused tests, explicit configuration, bounded collectors, evidence-oriented completion, and reusable safety primitives. The recurring problem is **contract drift across parallel paths**, not a need for a more elaborate architecture. Fix shared effects, continuation state, and guard placement first.
