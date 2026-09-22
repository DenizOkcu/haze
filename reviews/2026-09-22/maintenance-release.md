# Open-source maintenance, release workflow, and architecture

See [README](README.md). Findings remain open. Recommendations prioritize understandable contracts and small changes, not a rewrite.

## MR-01 — Release metadata is inconsistent and verification is absent from CI

**Priority:** P2 · **Evidence:** executed release verifier · **Confidence:** high.

**Locations:** `package.json:3`, `package.json:46-48`, `.github/workflows/ci.yml:41-48`, `scripts/verify-release-metadata.mjs:39-97`.

The checkout declares 1.2.1 while the lockfile root reports 1.2.0. `npm run release:verify` fails with 32 mismatches covering README, six static HTML pages, and AGENTS release stamps. The verifier is in prepublishOnly but not the CI job, so CI can remain green while the publish gate rejects the checkout. This does not prove a published package is broken.

**Smallest fix:** align intentional release metadata and execute the existing verifier in the release CI path. Longer term, remove unnecessary repeated version stamps or generate display stamps from one source; do not make every architectural instruction file require manual edits for every patch release unless that is genuinely useful.

**Acceptance:** release:verify passes; CI detects a deliberate metadata mismatch. Do not edit dependency resolution merely to change a version stamp.

## MR-02 — The default test result depends on stale local dist state

**Priority:** P2 · **Evidence:** executed suite and launcher · **Confidence:** high.

**Locations:** `tests/cli/binLauncher.test.ts:127-144`, `bin/haze.js:72-81`, `.github/workflows/ci.yml:43-45`, `package.json:48`.

The real-checkout test enables itself when dist's version matches, but the launcher additionally requires its commit to match HEAD. This checkout has same-version dist from 21e3822 while HEAD is b53d4e9, so npm test fails even though all other executed tests pass. A clean checkout without dist skips that test. CI builds only after testing, so it does not exercise the built real-checkout test on the clean path either.

**Smallest fix:** separate deterministic unit launcher fixtures from an explicit build-dependent artifact suite. Run the artifact suite after build in CI/release validation. Do not weaken the intentional stale-build refusal or delete generated output just to turn tests green.

**Acceptance:** unit results are stable with missing/stale/current dist; post-build artifact checks always execute and detect an intentionally stale manifest.

## MR-03 — CI uploads a tarball it never creates

**Priority:** P2 · **Evidence:** workflow inspection · **Confidence:** high.

**Locations:** `.github/workflows/ci.yml:48-54`.

The workflow runs npm pack --dry-run, then uploads *.tgz with if-no-files-found: ignore. Dry-run does not create a tarball, so ordinary clean jobs silently publish no package artifact despite the upload step's name.

**Smallest fix:** create an actual tarball after build if artifact distribution is intended, and fail when it is absent. Otherwise remove the misleading upload step. Keep dry-run only if its separate inspection value is wanted.

**Acceptance:** a clean CI job uploads exactly the expected package archive; install/smoke-test it in a disposable directory without project-home credentials.

## MR-04 — Release verifier misinterprets URL-encoded checkout paths

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `scripts/verify-release-metadata.mjs:8-16`.

The script converts import.meta.url using URL.pathname instead of fileURLToPath. A checkout under a directory containing spaces or URL-significant characters becomes a percent-encoded filesystem path, so the script reads the wrong root and reports missing metadata. Windows drive paths are also not handled correctly by this conversion.

**Smallest fix:** use Node's fileURLToPath and dirname/resolve, matching the existing launcher pattern.

**Acceptance:** run the verifier against a synthetic complete metadata fixture under a path containing spaces, #, and non-ASCII characters. The result must match the same fixture in a simple path.

## MR-05 — Duplicated Git provenance readers mishandle worktrees and gitdir paths

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `bin/haze.js:30-47`, `src/utils/buildInfo.ts:138-157`.

Both readers extract gitdir with a non-whitespace regex, do not resolve relative gitdir paths against the package root, and search branch refs only in the worktree-specific Git directory. Linked worktrees commonly store refs in the common Git directory. The helpers can return undefined and silently skip stale-commit verification. The bug exists in two near-identical implementations, demonstrating a concrete DRY maintenance cost.

**Smallest fix:** correctly handle relative gitdir paths, spaces, commondir, detached HEAD, loose refs, and packed refs. Prefer one dependency-free source if packaging/launcher bootstrap permits; otherwise share contract fixtures across both implementations rather than forcing a risky build-time dependency.

**Acceptance:** identical fixture cases for launcher and TypeScript provenance helper, including linked worktrees and a relative gitdir file. A resolvable mismatched checkout must not bypass the stale-build gate.

## MR-06 — Dead-export check is red and needs triage, not bulk deletion

**Priority:** P3 · **Type:** maintainability/tooling debt · **Evidence:** executed Knip.

**Locations:** `package.json:42`, `knip.json`, and the symbol locations below.

npm run lint:knip reports ten unused exports:

- resetAssistantSegment — `src/cli/commands/streaming/assistantSegments.ts:15`
- withScopedContextControl — `src/cli/commands/streaming/prepareStep.ts:32`
- MAX_MODEL_RETRIES_SETTING — `src/core/agent/budgets.ts:57`
- executedMutatedArtifact — `src/core/agent/workState.ts:183`
- findGoalLedgerFrontier — `src/core/session/sessionStore.ts:370`
- rangeContains — `src/llm/lsp/symbols.ts:60`
- selectToolsForRequest — `src/llm/requestContext.ts:43`
- changedPathsForDiagnostics — `src/llm/tools/toolContext.ts:176`
- evalEnabled — `tests/eval/harness.ts:34`
- evalPreflight — `tests/eval/harness.ts:50`

An unused export is not necessarily an unused function: several are used inside their own modules or deliberately exposed for tests. SU-01 also shows why deleting a duplicate helper without unifying its semantics is insufficient.

**Smallest fix:** inspect each use; remove unnecessary export modifiers, remove truly dead code, or configure intentional public/test surfaces precisely. Avoid blanket ignores or deleting useful test seams.

**Acceptance:** Knip has a documented clean baseline and still catches a newly added truly unused export. Typecheck, tests, and eval entrypoint discovery remain intact.

## Architecture assessment: what to keep and where to simplify

### Keep

- Plain TypeScript policy modules separated from React/Ink; evidence-based completion is a strong foundation.
- Shared bounded process execution, centralized limits, explicit provider selection, real-path confinement, scoped context, and private storage helpers.
- Existing focused tests and provider-free seams. The suite executed 1,788 tests, with 1,781 passing, one failing, and six skipped.
- Append-only transcript design and one-step SDK rollover are intentional reliability mechanisms, not abstractions to remove just because they are unusual.

### Concrete KISS/DRY follow-ups

1. **Normalize tool effects once.** AR-02/TS-08 show the same mutation contract is reimplemented in multiple lists. A small typed effects projection is preferable to more tool-name conditionals spread across observers, workers, and formatters.
2. **One continuation state carrier.** AR-04/AR-05/SU-01 show several resume paths retain different subsets of the same facts. Consolidate around existing checkpoint types; do not build a new workflow engine.
3. **One lifecycle cleanup discipline.** AR-06/AR-07 and SU-03 need explicit ownership/disposal and exhaustive callback handling, not more detached timeout wrappers.
4. **Separate orchestration from presentation incrementally.** `src/cli/commands/chat.tsx` is about 800 lines and the model runtime is under cli/commands/streaming despite being used headlessly. Keep public facades stable; extract cohesive lifecycle/evidence behavior only while fixing concrete bugs. File size alone is not a defect and does not justify a rewrite.
5. **Generate or delete duplicated release facts.** Version stamps, model catalogs, and capability contracts should have clear authorities. Preserve hand-authored data where it adds value; do not introduce generators solely to save a few literals.

### YAGNI guardrails for fixing agents

Do not add distributed coordination, a persistent job queue, plugin DI framework, a general shell parser, native provider adapters, a new state-machine dependency, or cross-process settings locking as a side effect of this review. Fix the demonstrated boundary with existing primitives. Keep Windows-specific durability work tied to the explicit support decision.
