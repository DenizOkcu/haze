# Tasks: OS-Level Process Sandboxing (seatbelt / bubblewrap)

**Input**: `specs/os-sandbox/` (spec.md, plan.md, research.md, contracts.md)
**Conventions**: `[P]` = parallelizable (different files, no deps). `[US1..US4]` = user story. Every phase ends with the validation command listed in its header unless noted otherwise. Never edit `dist/`. Local TS imports use `.js` extensions. No `any`; unused args prefixed `_`.

---

## Phase 0 — Spike & assumption verification (no product code)

*Validation: matrix table appended to `specs/os-sandbox/research.md` §6; go/no-go note for the default-mode flip added to `plan.md` §7.4.*

- [x] **[T0.1] [P] [US1]** Create throwaway probe scripts under `scripts/sandbox-spike/` (gitignored or deleted before merge; never shipped in the npm pack — verify with `npm pack --dry-run`): `seatbelt-probe.sh`, `bwrap-probe.sh`, `matrix.sh`.
- [x] **[T0.2] [US1]** macOS seatbelt probes: (a) deny-over-allow precedence for `(deny file-read* (literal …))` inside an allowed `(subpath …)`; (b) full login-shell (`zsh -l`, brew shellenv) matrix under the draft profile from `contracts.md` §3; (c) workspace symlink → `~/.ssh` is refused; (d) profile-compile error output shape; (e) `sandbox-exec -p '(version 1)(allow default)' true` as the availability probe.
- [x] **[T0.3] [US1]** Linux bwrap probes: (a) `--ro-bind /dev/null <mask>` after the owning dir bind masks reads (and after `--tmpfs $HOME` + subtree re-bind for nvm-style node dirs); (b) default uid/gid mapping with `--unshare-user` vs explicit `--uid`/`--gid` — record the chosen behavior; (c) userns-denied / AppArmor-restricted stderr strings for `detect.ts` classification; (d) grandchild teardown: start `bwrap … sh -c 'sleep 100 & wait'` background-style, SIGTERM the group, assert no leaks (with `--die-with-parent`).
- [x] **[T0.4] [US1]** Compat matrix (both backends): `npm ci && npm test` in this repo; `git status/diff`; `git commit` with ro-bound `~/.gitconfig`; python `python -m venv .venv && .venv/bin/python -c 1` (in-workspace); `node -e "fetch('http://127.0.0.1:PORT')"` against a test-started server; strict-profile network denial. Record every observed denial and the root-set change it motivated.
- [x] **[T0.5] [P] [US1]** Decide + document the default system read set / cache rw set from T0.4 evidence (update `contracts.md` §2/§3/§4 templates to match reality).
- [x] **[T0.6] [US3]** Confirm `commander` flag pattern for `--sandbox` choices against `src/cli/index.ts` (`--reasoning` precedent) and the `PromptSession` in-memory override pattern against `src/llm/systemPrompt.ts` (`reasoningByModel`).

## Phase 1 — Core sandbox modules (pure + detect)

*Validation: `npm run typecheck && npm test && npm run lint`.*

- [x] **[T1.1] [US1]** Create `src/core/sandbox/boundary.ts` per `contracts.md` §2: `SandboxBoundary`, `buildSandboxBoundary`, root normalization/realpath pass, dedup/absorption, secret-root rejection backstop, mask-list computation (from `src/core/safety/secretPaths.ts` concepts), network policy, deterministic ordering.
- [x] **[T1.2] [P] [US1]** Create `src/core/sandbox/seatbelt.ts`: `sbplString()` escaper, `seatbeltProfile()`, `seatbeltInvocation()`; denies last; no temp files (`-p` inline).
- [x] **[T1.3] [P] [US1]** Create `src/core/sandbox/bubblewrap.ts`: `bubblewrapArgs()` / `bubblewrapInvocation()` per `contracts.md` §4 ordering; `-try` variants for optional paths; `--chdir`; strict adds `--unshare-net`; no `--unshare-pid` (v1).
- [x] **[T1.4] [US1]** Create `src/core/sandbox/detect.ts`: `detectSandboxBackend()` (direct spawn, ≤5 s, stderr classification incl. `userns_denied`), module cache + `resetSandboxDetection()`; Windows → `none/unsupported_platform`; injected `spawnProcess` test seam.
- [x] **[T1.5] [US1]** Create `src/core/sandbox/runner.ts`: `resolveSandboxMode()` precedence (CLI → session → settings → default `auto`/`workspace`), `wrapInvocation()` with passthrough + truthful `ShellSandboxMetadata`.
- [x] **[T1.6] [P] [US4]** Create `src/core/sandbox/diagnostics.ts`: `classifySandboxDenial()` per `contracts.md` §8 (EPERM/EACCES/EROFS classes; ENOENT only when host-existing path is outside the boundary; never misfires on unrelated failures).
- [x] **[T1.7] [P] [US1]** Write `src/core/sandbox/AGENTS.md` (module contract: purity rules, trust rule "model cannot grow its own boundary", worker asymmetry, mask-list alignment clause with `SECRET_FILE_RULE`, test reset helpers).
- [x] **[T1.8] [P] [US1]** Tests: `tests/core/sandbox/boundary.test.ts`, `seatbelt.test.ts`, `bubblewrap.test.ts` (snapshots + ordering invariants), `detect.test.ts` (fake spawn), `diagnostics.test.ts`, `runner.test.ts` (mode precedence, passthrough). Use fake `runtime` facts for cross-platform determinism.

## Phase 2 — Settings + tool wiring

*Validation: `npm run typecheck && npm test && npm run lint`; e2e-gated tests green on a machine with a backend.*

- [x] **[T2.1] [US3]** `src/config/settings.ts`: `HazeSandboxSettings` + Zod (`contracts.md` §1); loud validation of secret-path roots; unknown-field preservation unchanged. Tests in `tests/config/settings.test.ts`.
- [x] **[T2.2] [US1]** `src/llm/tools/toolContextState.ts`: add `sandboxBoundary?` + `isHazeToolContext` arm; re-export via `toolContext.ts`.
- [x] **[T2.3] [US1]** `src/cli/commands/streaming/attemptSetup.ts`: build the boundary once per attempt (after `blessedPaths` resolution, line ~210 area) using `resolveSandboxMode` with overrides threaded through `TurnExecutionOptions` (`src/cli/commands/streaming.ts` gains `sandboxOverride?`); stash on the tool context. Rebuild on continuation/recovery attempts.
- [x] **[T2.4] [US1]** `src/llm/tools/shellTool.ts`: wrap foreground invocations via `wrapInvocation` before `runBoundedProcess` (primitive unchanged); attach `sandbox` metadata to all results; on failure run `classifySandboxDenial` → merge `sandbox_boundary` reason code + `suggestedNextStep` (`missing_executable` keeps precedence); `mode: 'on'` + no backend → fast-fail `sandbox_unavailable` result before spawning.
- [x] **[T2.5] [US1]** `src/core/process/backgroundRegistry.ts`: `startBackgroundProcess` accepts optional `sandboxBoundary`, wraps the same way; `src/llm/tools/shellTool.ts` background path passes it. Teardown semantics untouched.
- [x] **[T2.6] [US1]** `src/llm/tools/grepRunner.ts`: same wrapper (defense-in-depth; only if Phase 0 matrix showed rg unaffected — it lives under the workspace rw root).
- [x] **[T2.7] [P] [US4]** Update `tests/hazeTools/shell.test.ts` (+ background/process tests) for the metadata field, enabled-false passthrough, `sandbox_boundary`/`sandbox_unavailable` shapes; update `src/cli/commands/formatters.ts` to render the compact sandbox line + denial hint.
- [x] **[T2.8] [P] [US1]** E2E suite `tests/core/sandbox/e2e.sandbox.test.ts` gated on `HAZE_SANDBOX_E2E=1` + live probe; implement the 10-case matrix from `plan.md` §9 (incl. the "no key material in stdout" assertion for `~/.haze/settings.json`).
- [x] **[T2.9] [US1]** Worker wiring: `src/llm/workerContext.ts` / `src/llm/subagentRunner.ts` attach the same main-turn boundary to worker tool contexts (no worker-input blessings in v1 — document in `src/core/sandbox/AGENTS.md`).

## Phase 3 — UX surface

*Validation: `npm run typecheck && npm test && npm run lint` + manual QA checklist below.*

- [x] **[T3.1] [US3]** `src/cli/commands/commands.ts`: `/sandbox` handler per `contracts.md` §9 (status card, session-scoped mode/profile overrides via `PromptSession.sandboxOverride`, `/sandbox test` probes). Update `commandHelp.ts` + `docs/commands.html`.
- [x] **[T3.2] [US3]** `src/cli/index.ts`: `--sandbox <auto|on|off|strict>` run-scoped flag (never a settings write); thread through `runCommand.ts` headless path; help text updated.
- [x] **[T3.3] [US3]** `src/cli/commands/doctor.ts`: sandbox section (backend, reason, mode, profile, root counts, probe result).
- [x] **[T3.4] [US4]** Degraded-mode notice: one-time system message per session when `auto` + `none` backend (pattern: `PromptSession.contextFallbackWarned`); per-result `sandbox: {enabled: false, reason}` already from T2.4.
- [x] **[T3.5] [US4]** `src/llm/systemPrompt.ts`: add `SANDBOX_RULE` (only when backend active; options flag from `requestContext.ts`); keep aligned with `SECRET_FILE_RULE`; update `src/llm/hazeTools.ts` shell description to mention sandboxed execution.
- [x] **[T3.6] [P] [US3]** Manual QA checklist (record results in the PR): `/sandbox` status renders roots correctly with tilde shortening; `/sandbox off` → previously blocked command succeeds; `--sandbox strict` print-mode network command fails with hint; doctor shows backend on macOS + Linux + Windows (`unsupported_platform`).

## Phase 4 — Hardening & decision

*Validation: full matrix + `npm run typecheck && npm test && npm run lint && npm run build`.*

- [x] **[T4.1] [US1]** Adversarial spot-checks (scripted where possible; both backends): workspace symlink → `~/.ssh`; nested `sandbox-exec`/`bwrap` re-invocation attempts; `cd / && touch x`; hardlink-from-workspace to masked config file; write to `/etc`.
- [x] **[T4.2] [US1]** Perf check: per-command overhead measurement (target <30 ms p95 over 50 runs) recorded in the matrix; probe cost once per process.
- [ ] **[T4.3] [US1]** Full regression on macOS + Linux CI runners (add the Linux bwrap runner config if missing); Windows runner stays green (backend `none`, degraded path tested).
- [x] **[T4.4] [US3]** Default-mode decision per `plan.md` §7.4: with the matrix green, flip the settings default to `auto` (single constant + docs); otherwise keep `off` and document why in `plan.md`.
- [ ] **[T4.5] [P] [US4]** Optional (only if time permits): adversarial eval scenario under `.eval/` — sandbox-respecting behavior on a prompt-injected "read ~/.ssh" task; assert the model reports the boundary instead of working around it.

## Phase 5 — Docs & governance

*Validation: review; `npm pack --dry-run` shows no stray files.*

- [x] **[T5.1] [P] [US3]** `README.md`: "Sandboxing" section (platform support, default boundary table, settings + `/sandbox` + `--sandbox`, escape hatches, strict profile).
- [x] **[T5.2] [P] [US3]** New `docs/security.html` (nav entry; threat model summary, mask list, strict profile) + update `docs/tools.html` shell description.
- [x] **[T5.3] [P] [US3]** `SECURITY.md` boundary paragraph; `CHANGELOG.md` entry under the next minor.
- [x] **[T5.4] [US1]** Root `AGENTS.md`: new runtime-contract paragraph (precedence chain, trust rule, bless semantics at OS level, `SECRET_FILE_RULE` alignment clause); update `src/core/process/AGENTS.md`, `src/llm/tools/AGENTS.md`, `src/config/AGENTS.md` with the sandbox touchpoints.
- [x] **[T5.5] [US1]** Constitution amendment (`.specify/memory/constitution.md`): Principle IV clause for OS-level child-process boundaries + Technology Stack note (no new deps) + Sync Impact Report (per the established format at the top of that file).
- [x] **[T5.6] [P] [US3]** Final review pass: verify every ⚠ VERIFY item in `research.md` §6 is resolved and struck; remove spike scripts; confirm `npm pack --dry-run` contents.

---

## Definition of Done

- All phases checked; `npm run typecheck && npm test && npm run lint && npm run build` green on macOS + Linux (+ Windows degraded path).
- E2E matrix (10 cases) green on both backends when `HAZE_SANDBOX_E2E=1`; adversarial spot-checks pass.
- No credential material ever appears in any sandboxed command's stdout in tests (asserted).
- Docs, AGENTS.md contracts, constitution amendment, and CHANGELOG merged.
- Default-mode decision recorded in `plan.md` §7.4 with evidence.
