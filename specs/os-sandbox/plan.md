# Implementation Plan: OS-Level Process Sandboxing (seatbelt / bubblewrap)

**Branch**: `os-sandbox` | **Date**: 2026-10-16 | **Spec**: `specs/os-sandbox/spec.md` | **Research**: `specs/os-sandbox/research.md` | **Contracts**: `specs/os-sandbox/contracts.md` | **Tasks**: `specs/os-sandbox/tasks.md`

---

## 1. Summary

Add OS-enforced filesystem boundaries for **model-initiated child processes** (the `shell` tool's foreground and background commands):

- **macOS**: Seatbelt (`sandbox-exec`) with a generated deny-by-default SBPL profile.
- **Linux**: bubblewrap (`bwrap`) with a generated mount-namespace argv.
- **Windows**: no backend; `auto` degrades to off (visibly), `on` fails loudly.

Default boundary (`workspace` profile):

| Access | Paths |
|---|---|
| read-write | workspace root (`workspaceRoot()`), real `os.tmpdir()`, `~/Library/Caches` (macOS) or `~/.cache` + `~/.npm` (Linux), user `sandbox.rwRoots` |
| read-only | system tool dirs (`/usr`, `/bin`, `/lib*`, `/opt`, `/etc`, `/System`, `/Library`, …), the user shell's + node's install subtrees, `~/.haze` and `~/.claude` (credential files masked), `~/.gitconfig`, user `sandbox.roRoots`, **this turn's `blessedPaths`** |
| denied/absent | everything else, incl. other home content (`~/.ssh`, `~/.aws`, histories) and credential files inside the mounted config dirs |
| network | allowed (`workspace`), denied (`strict`) |

The turn-scoped read-bless set (`src/core/attachments/readBlessings.ts`) becomes an input to the boundary, so `@path`-mentioned files/dirs are readable by sandboxed commands for that turn — read-only, never writable (mirrors the existing "mutating tools never honour the bless set" rule at the OS level).

Control surface: `sandbox` settings block (default `mode: "auto"`), `/sandbox` session command, `--sandbox` run-scoped CLI flag, `haze doctor` section. Diagnostics: structured `sandbox` metadata on shell results and a `sandbox_boundary` / `sandbox_unavailable` reason-code path with actionable next steps. No confirmation dialogs — confinement, not permission-gating (Constitution I).

## 2. Technical Context

**Language/Version**: TypeScript strict, ESM, NodeNext, Node ≥22, `.js` import extensions, Zod for schemas, no `any`.
**Primary Dependencies**: none new — `sandbox-exec` (macOS, system) and `bwrap` (Linux, optional system package) are invoked as subprocesses; detection degrades cleanly when absent.
**Testing**: Vitest (`tests/core/sandbox/**`, `tests/hazeTools/shell.test.ts` updates); live-backend integration tests gated by `HAZE_SANDBOX_E2E=1` + probe; pure generators tested via snapshots with platform seams.
**Target Platforms**: macOS 13+ (Seatbelt), Linux (bubblewrap ≥ 0.8 preferred). Windows: `none` backend.
**Project Type**: CLI package `@denizokcu/haze`; source in `src/`, never edit `dist/`.

## 3. Constitution Check

| Principle | Status |
|---|---|
| I — no permission gates | ✅ The sandbox never asks; it confines and reports. Escape hatches are user actions (settings, `@mention`, `/sandbox off`), not dialogs. |
| II — minimal core | ✅ No new model-facing tool or workflow; safety plumbing under existing `shell`/`process` tools. Documented as a native guardrail primitive (Constitution IV territory), not a workflow exception. |
| III — bounded resources | ✅ No new unbounded effects: probes are short-deadline one-shot children; sandboxed commands run through the existing bounded spawner (budgets, tree teardown unchanged). |
| IV — strong real-path/network boundaries | ✅ Extends boundary enforcement from app-level to syscall-level for child processes. **Requires a constitution amendment** (Principle IV clause + Sync Impact Report; see §12). |
| V — truthful status | ✅ Backend availability, mode, and denials are reported truthfully in results/events/doctor; degraded runs are labeled, never silent. |
| VI — deterministic, UI-agnostic core | ✅ All generators are pure functions under `src/core/sandbox/`; the single effectful module (`detect.ts`) is cached with a reset helper; no React/Ink imports. |
| VII — explicit config, no env vars | ✅ Settings-only configuration (Zod, fail-loud, unknown fields preserved); no new env vars; `--sandbox` is a run-scoped override exactly like `--reasoning` (never a settings write). |
| VIII — private durable state | ✅ No new durable state; masks/denies *protect* `~/.haze` secrets from child processes. |
| IX — controlled delegation | ✅ Workers inherit the same boundary (no weaker); coordination semantics untouched. |

## 4. Architecture

```
                    ┌────────────────────────────────────────────────┐
 user prompt ──▶ userInput.ts ──▶ blessedPaths (turn-scoped, realpath'd)
                    │                                               │
 settings.json ──▶ settings.ts (sandbox block)                      │
                    │                                               │
                    ▼                                               ▼
             attemptSetup.ts ──▶ buildSandboxBoundary(workspaceRoot, blessed, settings, runtime)
                    │                    │
                    │                    ├── seatbelt.ts   (pure SBPL text + argv)
                    │                    ├── bubblewrap.ts (pure argv)
                    │                    └── detect.ts     (cached backend probe)
                    ▼
        HazeToolContext.sandboxBoundary (per attempt)
                    │
      ┌─────────────┼──────────────────┐
      ▼             ▼                  ▼
  shellTool.ts  backgroundRegistry  (grepRunner — optional task)
      │             │
      └── wrapInvocation(shellInvocation(cmd), boundary) ──▶ runBoundedProcess (UNCHANGED)
                                 │
                                 ▼
              result.sandbox metadata + diagnostics.ts denial heuristic
```

Design rules:

1. **The bounded-process primitive stays policy-free.** `runBoundedProcess` keeps spawning exactly what it is told; the sandbox wrapper argv is composed by callers via `wrapInvocation()`. This preserves the tested timeout/abort/tree-kill contracts and keeps policy review in one place.
2. **Boundary construction is per-attempt** (in `attemptSetup.ts`, next to `blessedPaths`) because blessings are turn-scoped; the boundary object is immutable for the attempt.
3. **`detect.ts` is the only effectful module**; everything else is pure and snapshot-testable. Caching is process-scoped with a `resetSandboxDetection()` test helper (Constitution VI).
4. **Fail-open vs fail-closed is explicit**: `mode: "auto"` = degrade to unsandboxed **with a visible one-time notice + per-result `sandbox: {enabled: false, reason}`**; `mode: "on"` = refuse to run model commands unsandboxed (`sandbox_unavailable`, `recoverable: false`, actionable message).
5. **Model cannot grow its own boundary.** Roots come only from settings (user-written), the workspace root (user-launched cwd), and user-typed mentions. Tool inputs never add roots.

## 5. Module specification — `src/core/sandbox/`

### 5.1 `boundary.ts` (pure)

`buildSandboxBoundary(input): SandboxBoundary` — see `contracts.md` §2 for exact types. Inputs: `workspaceRoot`, `blessedPaths`, sandbox settings, runtime facts (`platform`, `homedir`, `tmpdir`, `shellPath`, `nodeExecDir`). Behavior:

- Normalize + `fs.realpath` roots where they exist (blessings already carry real paths; settings roots are tilde-expanded then realpath'd best-effort with lexical fallback, mirroring `requestedRealPath` semantics in `workspaceFile.ts`).
- Deduplicate roots that are subpaths of other roots with the same-or-weaker access (a ro root inside the workspace is absorbed; a rw root wins over a covering ro root).
- **Drop any candidate root that is itself a protected secret path or inside one** (`isProtectedSecretPath` from `core/safety/secretPaths.ts`): user settings cannot bless `~/.ssh` into the sandbox read set. Fail loudly at settings-validation time already; this is the runtime backstop.
- Compute the **credential mask list** for the mounted config dirs (see §6.2) from `secretPaths.ts`-derived constants — single source of truth, exported for both backends.
- Resolve network policy (`workspace` → allow, `strict` → deny) and emit the profile name.
- Pure wrt the filesystem except the realpath pass, which is memoized per call; all platform facts arrive as inputs (test seams).

### 5.2 `seatbelt.ts` (pure)

`seatbeltInvocation(target: {command, args}, boundary): {command: 'sandbox-exec', args: string[]}` and `seatbeltProfile(boundary): string`:

- Profile: `(version 1) (import "system.sb") (deny default)` + allow blocks per boundary (see `contracts.md` §3 for the exact template and ordering: read allows → write allows → exec allows → network allow/deny → **deny literals last** for credential masks + dev-node hardening like `/dev/kmem`).
- The profile string is passed via `-p` (single argv entry; no temp files).
- `--` separator, then the original `shellInvocation` target verbatim.
- Deterministic output (sorted, deduped) — snapshot tests pin it.

### 5.3 `bubblewrap.ts` (pure)

`bubblewrapInvocation(target, boundary, runtime: {uid, gid}): {command: 'bwrap', args: string[]}`:

- Fixed prologue: `--unshare-user --uid <uid> --gid <gid> --unshare-ipc --unshare-uts --die-with-parent`.
- System ro-binds with `--ro-bind-try` (merged-/usr safe), `--proc /proc`, `--dev /dev`, `--tmpfs /dev/shm`, `--tmpfs /tmp` (or bind real private `TMPDIR` when set outside `/tmp`).
- `--tmpfs $HOME`, then post-tmpfs `--ro-bind` for: `~/.haze`, `~/.claude`, `~/.gitconfig` (try), node/shell install subtrees under `$HOME`, blessed roots, settings `roRoots`.
- Credential masks: `--ro-bind /dev/null <path>` **after** the owning dir bind (ordering pinned by tests).
- `--bind <workspace> <workspace>` (+ any rwRoots / cache dirs), `--chdir <workspace>`.
- Strict profile adds `--unshare-net`; workspace profile shares the host network stack.
- `--` then the original target verbatim. Deterministic ordering, snapshot-pinned.

### 5.4 `detect.ts` (effectful, cached)

- `detectSandboxBackend(): Promise<SandboxBackendInfo>` — `{backend: 'seatbelt' | 'bubblewrap' | 'none', reason?, detail?}`.
- Probes (short timeout, e.g. 5 s, no shell — direct `spawn`): macOS → run `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`; Linux → run minimal `bwrap --ro-bind /usr /usr --dev /dev --proc /proc --unshare-user --uid … true` and capture stderr for classification (missing binary vs userns-denied vs AppArmor-restricted).
- Result cached module-scope; `resetSandboxDetection()` exported for tests. Never throws — failures become `none` + reason.
- Windows: immediate `none` with `reason: 'unsupported_platform'`.

### 5.5 `runner.ts` (composition)

- `wrapInvocation(target, boundary, backendInfo): {invocation, sandbox: ShellSandboxMetadata}` — picks the backend, returns the wrapped argv plus truthful metadata (`{enabled, backend, profile, degraded?, reason?}`). When disabled: passthrough + `enabled: false`.
- `resolveSandboxMode(precedence: cliOverride, sessionOverride, settings)` — `--sandbox` flag → `/sandbox` session state → settings, mirroring the `--reasoning` precedence pattern (documented in root `AGENTS.md` runtime contracts).

### 5.6 `diagnostics.ts` (pure)

`classifySandboxDenial({code, signal, stderr, boundary}): SandboxDenial | undefined`:

- Patterns (case-insensitive, bounded scan of the already-retained stderr text): `operation not permitted`, `read-only file system`, `permission denied`, `sandbox`+`deny` composites (macOS), `no such file or directory` for paths that exist on the host but are outside the boundary (Linux ENOENT class — checked against the boundary's known roots, only when the referenced path exists outside; avoids misfiring on genuine missing files).
- Returns `{kind: 'read' | 'write' | 'exec' | 'network' | 'unknown', pathHint?}` → shell result `reasonCode: 'sandbox_boundary'` + `suggestedNextStep` naming the three user actions (bless via `@path`, extend `sandbox.roRoots`/`rwRoots`, `/sandbox off`). Must **not** attach when the command failed for unrelated reasons (test both directions).

## 6. Integration specification

### 6.1 Settings (`src/config/settings.ts`)

Add `sandbox?: HazeSandboxSettings` (Zod schema in `contracts.md` §1): `mode: 'auto' | 'on' | 'off'` (default `auto`), `profile: 'workspace' | 'strict'` (default `workspace`), `roRoots: string[]`, `rwRoots: string[]`. Validation fails loudly with field-precise errors; unknown settings fields keep being preserved. Roots are `~`-expanded at use time, not stored expanded.

### 6.2 Credential mask list (single source of truth)

Exported from `boundary.ts` (derived alongside `secretPaths.ts` concepts):

- `~/.haze`: `settings.json`, `settings.local.json`, `sessions/`, `logs/`, `input-history*`, `update-cache*` — everything credential/transcript-bearing.
- `~/.claude`: `.credentials.json`, `settings.json`, `settings.local.json`, `projects/` (transcripts).
- Everything under `PROTECTED_HOME_DIRS` is simply **not mounted/allowed** (never explicitly bound), so no per-file masks are needed there.

Keep this list and `SECRET_FILE_RULE` conceptually aligned; changing either updates the other's docs (root `AGENTS.md` contract).

### 6.3 Tool context + attempt wiring

- `toolContextState.ts`: `HazeToolContext` gains `sandboxBoundary?: SandboxBoundary` (+ guard arm in `isHazeToolContext`). `toolContext.ts` re-exports.
- `attemptSetup.ts`: after building `blessedPaths`, call `buildSandboxBoundary(...)` once per attempt (mode resolution via `runner.resolveSandboxMode` with the session/CLI overrides threaded through `TurnExecutionOptions`) and stash it on the context. Continuation/recovery attempts rebuild it (blessings may differ across goal continuations — boundary follows the *current* turn's user intent).
- `shellTool.ts`: `const wrapped = wrapInvocation(shellInvocation(executionCommand), boundary, backend)` → `runBoundedProcess({...wrapped, cwd, ...})` (cwd stays the workspace). Attach `sandbox: wrapped.sandbox` to **every** shell result (ok and failed). On failure, run `classifySandboxDenial` and merge `reasonCode`/`suggestedNextStep` (existing result precedence: missing-executable diagnosis wins over sandbox-denial classification when both apply; sandbox metadata still rides along).
- `backgroundRegistry.ts`: `startBackgroundProcess` input gains optional `sandboxBoundary`; same `wrapInvocation` before `spawn`. Tree teardown (`signalProcessTree`, `--die-with-parent`, escalation) is untouched — Phase 0 verifies grandchild reaping under bwrap.
- `grepRunner.ts` (Phase 2, low-risk uniformity): same wrapper; rg already workspace-confined, so this is defense-in-depth. Include only if the compat matrix shows no regressions (rg binary lives under `node_modules` inside the workspace — inside the rw root by construction).

### 6.4 Result shapes & UI

- Shell result: new optional `sandbox` object (`contracts.md` §4) — protocol-safe, bounded, JSON-serializable; update `formatters.ts` with a compact line (`sandbox: seatbelt(workspace) rw:1 ro:14` style) and a denial hint line; update `commandHelp`/`tools.html` docs.
- Degraded mode (`auto` + `none` backend): one-time system message per session ("Sandboxing unavailable: <reason>. Commands run unsandboxed. /sandbox for options.") + `sandbox: {enabled: false, reason}` per result. Never more than once per session (pattern: `contextFallbackWarned` on `PromptSession`).
- `haze doctor`: sandbox section — backend, version if cheap, mode, profile, root counts, probe result.

### 6.5 System prompt (`src/llm/systemPrompt.ts`)

Add `SANDBOX_RULE` (concise, behavior-explicit, aligned with `SECRET_FILE_RULE`):

> Commands may run inside an OS sandbox: reads/writes are confined to the project directory, temp, and caches; some config dirs are read-only. When a command fails with a sandbox boundary hint, do not attempt workarounds (no re-shelling, no copying via other tools). Tell the user which path is needed: they can `@mention` it in the prompt to grant a read, extend `sandbox.roRoots`/`rwRoots` in settings, or disable the sandbox with `/sandbox off`.

Only include the sentence when the backend is active (options flag from `requestContext.ts`), keeping the prompt honest when sandboxing is off.

### 6.6 Subagents / fleet / headless

- Workers build their tool contexts via `workerContext.ts`/`subagentRunner.ts`; they must attach the **same** boundary (main-turn settings; workspace root identical). Worker input mentions do **not** create new blessings in v1 (worker capsules are model- or user-composed task text; only main-prompt user typing blesses) — document this asymmetry in `src/core/sandbox/AGENTS.md`.
- Headless/print mode: identical path (`runCommand.ts` threads the `--sandbox` flag as a run-scoped override). Exit-code semantics unchanged (Constitution V).

### 6.7 CLI + slash command

- `src/cli/index.ts`: `--sandbox <auto|on|off|strict>` (choices; `strict` = `profile` override for the run). Run-scoped only — never writes settings (mirrors `--reasoning`).
- `/sandbox` (registered in `commands.ts`): no-arg → status card (backend + probe reason, mode source chain, profile, rw/ro roots with tilde-shortened paths, mask count); `/sandbox auto|on|off|workspace|strict` → session-scoped override stored on `PromptSession` (in-memory only, like `reasoningByModel`); `/sandbox test` → runs three probe commands (`inside write`, `outside read`, `config read`) and prints pass/fail. `updateSettings`-based persistent changes are documented as the settings route (the command edits settings only when invoked as `/sandbox set …` — decide during implementation; prefer read-only + guidance to keep the command surface small).

## 7. Explicit non-goals & deferred decisions

1. **LSP/MCP children unsandboxed in v1.** User-configured infra; several servers write outside the workspace (caches, logs, sockets) and would break. Revisit: add `sandbox.applyToLsp` setting later if demanded.
2. **PID namespaces (bwrap `--unshare-pid`)** deferred: preserves exact `signalProcessTree` semantics; `--die-with-parent` covers leak safety. Revisit with a dedicated teardown test matrix if pursued.
3. **Network allow-lists** inside the sandbox: out of scope (see `research.md` §4).
4. **Default mode**: ship v1 with `mode: "auto"` **only after** the Phase 4 compatibility matrix passes on macOS + one userns-enabled Linux CI runner; until then land everything behind default `off` with a one-line flip task (settings default constant + docs). The flip is a reviewed decision, not a silent one (Constitution VII spirit). **Decision 2026-10-16**: shipped with default `auto`/`workspace` — the live seatbelt e2e matrix is 10/10 green on macOS 27/arm64 and the boundary was exercised against real dev tooling; the Linux bwrap half remains covered by unit tests + gated e2e until a bwrap CI runner exists (T4.3 open).

## 8. Phases

See `tasks.md` for the per-task checklist. Phase summary:

| Phase | Deliverable | Gate |
|---|---|---|
| 0 — Spike | `research.md` ⚠ items verified; probe scripts in `scripts/sandbox-spike/` (not shipped) | compatibility matrix table filled; go/no-go on default mode |
| 1 — Core | `src/core/sandbox/*` pure modules + `detect.ts`; unit tests + snapshots | `npm run typecheck && npm test && npm run lint` |
| 2 — Integration | shell/background/grep wiring, context field, settings schema, diagnostics, result metadata | tool tests updated; e2e-gated matrix green on dev machines |
| 3 — UX | `/sandbox`, `--sandbox`, doctor, system prompt rule, degraded-mode notice | manual QA checklist in `tasks.md` |
| 4 — Hardening | full e2e matrix (both backends), adversarial spot-checks, worker/headless paths, perf check (probe ≤5 s once) | matrix green; default-mode flip decision |
| 5 — Docs & governance | README, `docs/security.html`, SECURITY.md, CHANGELOG, AGENTS.md contracts (root + `src/core/sandbox/`), constitution amendment + Sync Impact Report | review |

## 9. Test strategy

**Unit (always run)**

- `tests/core/sandbox/boundary.test.ts` — root computation, dedup/absorption, secret-root rejection, mask list, tilde expansion, platform seams (fake runtime facts), strict vs workspace network.
- `tests/core/sandbox/seatbelt.test.ts` / `bubblewrap.test.ts` — snapshot tests of generated profile/argv for canonical boundaries; ordering invariants (masks after dir binds; `--` last); determinism.
- `tests/core/sandbox/detect.test.ts` — fake spawn seam: present/missing/userns-denied/windows paths; caching + reset.
- `tests/core/sandbox/diagnostics.test.ts` — denial classification true/false cases (incl. unrelated failures).
- `tests/config/settings.test.ts` — sandbox schema validation errors (field-precise), unknown-field preservation.
- `tests/hazeTools/shell.test.ts` — metadata presence/enabled-false passthrough; `sandbox_boundary` reason code shape; background path.

**Integration (gated: `HAZE_SANDBOX_E2E=1` AND probe reports a backend; skip otherwise — CI macOS runner + a Linux runner with bwrap setuid or open userns)**

Matrix (each on both backends where applicable):

1. write+read inside workspace → ok
2. read `~/.haze/AGENTS.md` → ok; `cat ~/.haze/settings.json` → empty/denied (assert **no key material** in stdout)
3. read `~/.ssh/id_ed25519` → denied (macOS) / ENOENT (Linux)
4. write `~/pwned` → denied
5. sibling-project read (no blessing) → denied; with `@../sibling` blessing → read ok, write denied
6. `npm ci && npm test` inside the haze repo (dogfood)
7. `git status` with `~/.gitconfig` ro-bound
8. network: `node -e "fetch('http://127.0.0.1:<local server>')"` against a test-started server → ok (workspace) / fails (strict)
9. background process: start dev server in sandbox, kill via `process` tool, assert no leaked pids (bwrap `--die-with-parent` check)
10. exit-code truthfulness: denied command reports non-zero + reason code; status mapping unchanged

**Adversarial spot-checks (Phase 4, manual/scripted)**: symlink from workspace → `~/.ssh` (must fail); `sandbox-exec`/`bwrap` re-invocation attempts (must not loosen); `cd /` + writes; reading masked config file via a hardlink/copy trick inside workspace (hardlinks can't be created across the boundary — verify ENOENT/EPERM).

**Regression**: full `npm run typecheck && npm test && npm run lint && npm run build` after each phase; `npm pack --dry-run` before release (no new files outside `dist/` contract).

## 10. Performance & resource notes

- Backend probe: once per process, ≤5 s budget, result cached. Turn latency impact ≈ zero after that.
- Per-command overhead: argv composition is pure string work; seatbelt/bwrap exec cost is single-digit ms typically — measure in Phase 4 (target: <30 ms overhead per command p95; record in the matrix).
- No new memory-resident state beyond the cached probe and the immutable boundary object per attempt.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Default profile breaks real workflows (caches, toolchains) | Phase 0/4 compat matrix drives the default root set; escape hatches shipped in the same release; default-mode flip is a gated decision (§7.4) |
| `sandbox-exec` removed by Apple | backend pluggable, probe degrades to `none` visibly; no hard dependency |
| bwrap unavailable/restricted (Ubuntu AppArmor) | probe classifies the cause; `sandbox_unavailable` message lists remedies; `auto` degrades visibly |
| Denial heuristics misfire (false `sandbox_boundary`) | heuristic requires boundary-relevant evidence (path exists outside boundary / EPERM-class errno), tested both directions; metadata-only otherwise |
| Users bless secrets via `roRoots` | runtime backstop drops protected-secret roots + settings validation warns loudly; documented trust model |
| Signal/teardown regressions under bwrap wrapper | wrapper pid = group leader as today (bwrap execs child in same group; sandbox-exec execs directly); e2e background-kill test pins it |
| Scope creep (network rules, LSP, Windows) | Non-Goals enforced by review against this plan |

## 12. Documentation & governance deliverables

- `README.md`: "Sandboxing" section (what/when/how to configure, escape hatches, platform support).
- `docs/security.html` (+ nav entry + `site.js` if pages are registered there): full boundary model, mask list, threat model summary, strict profile.
- `SECURITY.md`: add OS-boundary paragraph + reporting note.
- `CHANGELOG.md`: feature entry under the next minor.
- `AGENTS.md` (root): new runtime-contract paragraph (precedence chain, trust rule "model cannot grow its own boundary", bless semantics at OS level, alignment clause with `SECRET_FILE_RULE`).
- `src/core/sandbox/AGENTS.md` + `src/core/process/AGENTS.md` + `src/llm/tools/AGENTS.md`: nested contracts for the new module and touched boundaries.
- Constitution amendment: Principle IV gains "model-initiated child processes MUST run inside the OS sandbox boundary when a backend is available and mode is on/auto…" + Technology Stack note (no new deps) + Sync Impact Report appended per the established format.
