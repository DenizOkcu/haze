# Subagent Value Improvements — Production Readiness

**Assessed:** 2026-07-31
**Recommendation:** **launch** (`G6: pass`)

## Documentation changes and verification

The implementation already updated the main user-facing surfaces:

- `README.md` explains disposable context isolation, four worker modes, explicit profiles/model behavior, `/fleet` flags, deadline quarantine, mutation serialization, ephemeral controls, and non-durable result handles.
- `docs/index.html` describes the revised `subagent` and `/fleet` behavior.
- `src/cli/commands/commandHelp.ts` and `src/cli/chat/inputSuggestions.ts` match the implemented `/fleet` syntax.
- Relevant nested `AGENTS.md` files record the new runtime and persistence contracts.

This readiness pass made two necessary release/documentation fixes:

1. Added 0.9.0 release notes in `CHANGELOG.md` for the context-isolated subagent contract, `/fleet` controls, hard runtime limits, mutation coordination, and quarantine behavior.
2. Added `.pi-sessions/` to `.gitignore`. Child-agent JSONL files under `docs/subagent-value-improvements/.pi-sessions/` are private workflow runtime state and are now ignored rather than proposed for source control.

The documented settings example matches `src/config/settings.ts` and `src/core/subagent/executionProfiles.ts`: `subagents.workerModel`, `subagents.defaultProfile`, and bounded custom `subagents.profiles` are accepted; the built-ins are `local-safe`, `local-throughput`, `cloud-balanced`, and `cloud-fast`. No product behavior was changed in this phase.

## Final behavior summary

- A single substantial independent task may use `subagent` to keep noisy exploration out of the parent conversation; parallel fan-out is no longer the only value proposition.
- Workers receive one bounded task capsule and no parent/sibling history or fleet guidance. They independently load applicable root and scoped project instructions and track instruction signatures.
- Modes provide fixed tool diets: `inspect`, `research`, `implement`, and `validate`. Read-only modes have no bash or mutation tools.
- Raw execution retains bounded local telemetry and compatibility fields, while AI SDK `toModelOutput` sends only the compact truthful result capsule to the parent model.
- Terminations distinguish completed, no output, step/tool limits, deadline, cancellation, provider failure, and policy block.
- Worker model selection and execution profiles are explicit. No profile is inferred from provider/endpoint, and invalid explicit model/profile references block instead of falling back.
- One turn-scoped coordinator hard-enforces concurrency and per-execution tool-call budgets. Mutation-capable work and bash share a conservative retry-wide workspace lease.
- Deadlines return logical control promptly. Abort-ignoring work remains quarantined and retains its physical concurrency/mutation slot until it settles.
- `/fleet` remains parallel-only, supports `--review`, `--profile`, `--workers`, `--concurrency`, and `--`, and persists only the original invocation—not synthetic control guidance or per-run overrides.

## Production readiness checklist

- [x] The preferred flat tool contract is compatibility-covered and has no union branches; direct string runner calls and V1 raw result consumers remain supported.
- [x] Parent/worker context isolation is covered, including installed AI SDK model-output behavior.
- [x] Root/scoped instruction precedence, sibling exclusion, signatures, and lazy refresh are covered.
- [x] Explicit model/profile resolution and provider request-option propagation are covered.
- [x] Concurrency, hard tool caps, deadline/cancellation races, quarantine, fairness, and mutation leases are covered deterministically.
- [x] Retry-wide execution scope and ephemeral `/fleet` control are covered.
- [x] JSONL persistence retains compact durable state and excludes control prose, worker telemetry, and private tool detail.
- [x] User help, README, docs site, settings example, and changelog match implementation.
- [x] Child `.pi-sessions` runtime files are locally ignored.
- [x] npm package contents exclude workflow docs, specifications, and `.pi-sessions` files.
- [x] Full release validation passes on Node 26 against the declared Node `>=22` support floor.

## Validation status

Fresh final validation completed successfully on 2026-07-31:

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | Pass — 105 files, 943 tests |
| `npm run lint` | Pass |
| `npm run build` | Pass |
| `npm pack --dry-run --json` | Pass — `@denizokcu/haze@0.9.0`, 269 files, 213,566 B packed / 1,256,539 B unpacked |
| `git diff --check` | Pass |

Package inspection found **zero** entries from `.pi-sessions`, `docs/subagent-value-improvements`, or `specs/`. Optional live cloud/local smoke tests were not run because they require user-configured provider endpoints and are intentionally non-gating.

## Operational, security, and privacy considerations

- **Private execution boundary:** parent model context receives only the result capsule. Full worker transcripts are not a durable feature.
- **Local telemetry:** bounded raw telemetry is available to live UI/accounting and debug paths. Users should remember that `--debug` intentionally enables detailed local model logs under `~/.haze/logs`.
- **Workflow session privacy:** `.pi-sessions` JSONL files can contain agent prompts and tool activity. They must remain local, uncommitted, and unpublished; the new ignore rule enforces the normal repository path.
- **Durable sessions:** session slimming removes subagent telemetry/private tool detail and synthetic fleet controls, while preserving the original user invocation and compact capsules.
- **Result handles:** handles are process-local and non-durable. Consumers must use the capsule deliverable as the durable result.
- **Deadlines:** logical timeout does not imply that an uncooperative endpoint/process has physically stopped. Quarantined work deliberately retains real runtime and mutation capacity until settlement to prevent unsafe overlap.
- **Mutation policy:** serialization coordinates shared-workspace access but is not a shell sandbox. `implement` and `validate` workers can execute commands with the user's permissions.
- **Providers:** no hidden provider/model fallback exists. Worker request headers/options follow the explicitly resolved provider configuration; secrets must continue to be protected by existing settings and debug-log practices.
- **No remote telemetry:** this feature adds no telemetry upload, pricing lookup, or paid-provider CI dependency.

## Field-validation update

A local-model `/fleet --review` run after the initial readiness pass emitted empty `{}` subagent inputs against the transitional preferred/legacy union schema. The registered schema was simplified to one flat required `objective`/`deliverable`/`mode` object, descriptions and fleet control were clarified, and a JSON-schema regression test now rejects union branches. This intentionally removes legacy model-facing `{task, tools, maxSteps}` calls while preserving direct string runner and V1 raw-result compatibility.

A second live run produced valid capsules, then AI SDK rejected an undefined tool context because `subagent` unnecessarily declared `hazeToolContextSchema`. The real main turn only supplies per-tool Haze context to built-in file/bash tools, and subagent execution needs only the standard abort signal. The unnecessary context schema was removed, and the installed-SDK integration now executes without a subagent `toolsContext` entry.

The following live attempt reached worker execution but initially generated objectives beyond the strict 1,200-character limit. The accepted bound is now 4,000 characters, while schema descriptions and fleet control request objectives below 1,000 characters. This avoids wasting a fleet wave on verbose but otherwise valid calls without encouraging large normal handoffs.

## Known caveats

- Fleet decomposition and aggregation quality remain model/prompt driven and parallel-only; runtime controls resources but does not infer dependency graphs.
- Workspace-wide mutation serialization is intentionally conservative and may reduce throughput for truly disjoint edits.
- An abort-ignoring provider/tool can remain quarantined indefinitely and hold capacity; this is safer than releasing a live mutator into concurrent work.
- Worker scope normalization currently assumes the supplied session cwd equals `process.cwd()`, which is true for the current CLI path but should be revisited for future SDK callers.
- Cancelling a queued head mutation does not immediately re-run admission; safe reads behind it may wait until another submission or physical settlement. Review classified this as a low availability nit, not a release blocker.
- Retry and JSONL durability are proven through layered boundary tests rather than one recorder-level end-to-end test.
- Live behavior across representative cloud and local OpenAI-compatible endpoints has not been smoke-tested in this environment.

## Deferred features — not blockers

The following are explicitly deferred and do **not** block launch:

1. Structured `FleetPlan` generation, dependency scheduling, an extra planning/aggregation model round, and `/fleet --auto`.
2. LSP semantic-review mode and approved MCP/skill inheritance inside workers.
3. Recursive, persistent, or resumable worker conversations.
4. Parallel shared-tree mutation, patch-return workers, transactional edits, and isolated worktrees.
5. Durable worker transcripts, durable fleet artifacts, and durable result handles.
6. Remote telemetry, provider pricing/cost estimates, and speedup claims.
7. Paid-provider CI and mandatory live-model evaluation.
8. A broader session-cwd-rooted context-loader API.
9. Immediate admission after queued-head cancellation and a recorder-level retry-to-JSONL integration test.

## Launch recommendation

**Launch 0.9.0 with this feature.** All acceptance criteria have implementation and test evidence, release commands pass, user-facing documentation is aligned, and private child-session files are excluded from both git status and npm packaging. The remaining items are low-risk operational caveats or deliberate future enhancements, not release blockers.
