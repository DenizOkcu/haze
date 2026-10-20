# Feature Specification: OS-Level Process Sandboxing (seatbelt / bubblewrap)

**Feature Branch**: `os-sandbox`
**Created**: 2026-10-16
**Status**: Draft (ready for `/speckit-plan` → see `plan.md`)
**Input**: User description: "Add OS level boundaries like seatbelt on macOS and bubblewrap on Linux which should default to the directory the user opened the project in, the configuration files in `~/.haze` and `~/.claude`, and all files and directories the user blessed by mentioning them with the current file path system."

## Problem Statement

haze's boundary story today is application-level only:

- Model-selected **file tools** are lexically and real-path-confined to the workspace (`src/utils/path.ts`, `src/llm/tools/workspaceFile.ts`), with a turn-scoped read-bless exception for user-typed `@path` mentions (`src/core/attachments/readBlessings.ts`).
- The **shell tool** runs commands as the user's login shell with **no filesystem confinement at all** (`src/llm/tools/shellTool.ts` → `core/process/runBoundedProcess.ts`). Secret avoidance is prompt-instructed (`SECRET_FILE_RULE`), and path discipline relies on the model's good behavior.

A prompt-injected instruction, a poisoned `package.json` script, or a plain model mistake can therefore read `~/.ssh`, exfiltrate the home directory, or write anywhere the user can write — the agent process has the user's full filesystem authority.

OS-level sandboxing closes that gap for **model-initiated child processes**: on macOS via the Seatbelt profile system (`sandbox-exec`), on Linux via `bubblewrap` (bwrap) user/mount namespaces.

## Goals

1. **Default boundary = the project.** When sandboxing is active, every model-initiated child process gets read-write access to exactly the workspace root (the directory the user opened haze in, i.e. `process.cwd()` / `workspaceRoot()`), plus temp/cache locations, and read-only access to system directories needed to run dev tooling.
2. **Configuration dirs are readable.** `~/.haze` and `~/.claude` are mounted read-only into the sandbox so tooling that reads agent config/context keeps working — with credential-bearing files inside them explicitly masked (see Non-Goals/Secrets).
3. **Blessed paths flow through.** Every path the user blessed this turn by `@path` mention or a bare slash-containing path (the existing `blessedPaths` turn state) becomes a read-only root in the sandbox profile for child processes spawned during that turn.
4. **Fail-visible, not fail-silent.** Sandbox denials surface as structured, actionable shell-tool results (reason code, what was outside the boundary, how to fix: bless the path, add a settings root, or disable for the session). No confirmation dialogs — this is a confinement boundary, not a permission gate (Constitution I).
5. **Explicit user control.** A `sandbox` settings block, a `/sandbox` session command, a `--sandbox` run-scoped CLI flag, and `haze doctor` visibility. Degrading (backend missing) is always announced, never silent.

## Non-Goals (v1)

- **No sandboxing of the haze main process.** haze itself needs provider network, `~/.haze` writes, and full tool access. The target is child processes spawned by the `shell`/`process` tools.
- **No sandboxing of LSP servers or MCP stdio servers** (v1). They are user-configured infrastructure, not model-chosen commands, and several write caches/logs outside the workspace. Revisit after v1; see `plan.md` §7.
- **No Windows support.** Windows stays on application-level confinement; `sandbox.mode: "on"` errors loudly there, `auto` degrades to off with an informational note.
- **No network filtering inside the sandbox beyond allow/deny.** The default `workspace` profile allows network (npm/pip/cargo need it); the `strict` profile denies it entirely (bwrap `--unshare-net`, seatbelt `deny network*`). Fine-grained egress rules belong to the existing `fetch` tool guard, not to this feature.
- **No secret-content filtering for workspace-internal files.** Reading a workspace `.env` from a sandboxed shell stays possible (it is today; `source .env` is a legitimate workflow). OS-level *denials* apply only to credential files inside the explicitly mounted config dirs (`~/.haze/settings.json`, `~/.claude/.credentials.json`, …) because mounting those dirs is this feature's choice. The existing file-tool secret refusal and `SECRET_FILE_RULE` are unchanged and stay aligned.
- **No resource limiting** (CPU/memory/fork-bomb caps). Existing process budgets, timeouts, and tree teardown continue to apply unchanged.
- **No new model-facing tool.** The sandbox is plumbing under `shell`/`process`; Constitution II is respected (guardrail primitive, not workflow).

## User Stories

### US1 — Default workspace boundary (Priority: P1)

As a developer running haze in a project, when the sandbox is available and enabled, every shell/background command the model runs can read and write inside the project directory and temp/cache dirs, read system tooling and `~/.haze`/`~/.claude` config (minus credential files), and **cannot** read or write anywhere else on my machine.

**Why this priority**: This is the entire value proposition — blast-radius containment of model-initiated processes.

**Independent test**: With sandboxing on, `shell` runs `ls ../<sibling>`/`cat ~/.ssh/id_ed25519` and fails with a structured `sandbox_boundary` result; `npm test` inside the workspace still passes.

**Acceptance scenarios**:

1. Given haze started in `/repo`, when the model runs `shell "echo hi > /repo/out.txt"`, then the write succeeds and the result is `ok`.
2. Given the same session, when the model runs `shell "cat /etc/passwd > /tmp/x; ls ~/"`, then reads of world-readable system files succeed (system dirs are read-only roots) but `~/` listing shows only the mounted config dirs and the home tmpfs, and writes outside workspace/tmp/cache fail with EPERM surfaced as a sandbox denial hint.
3. Given a credential file `~/.haze/settings.json` containing provider API keys, when a sandboxed command tries `cat ~/.haze/settings.json`, then it reads an empty/masked file (bwrap `/dev/null` bind) or is denied (seatbelt explicit deny) — keys never reach stdout.
4. Given the sandbox backend is missing (no `bwrap`, userns disabled, or Windows), when mode is `auto`, then the command runs unsandboxed and the shell result + a one-time UI notice state that sandboxing is inactive and why; when mode is `on`, the command fails fast with an actionable error (how to install/enable the backend) and `reasonCode: 'sandbox_unavailable'`.

### US2 — Blessed paths extend the boundary read-only (Priority: P1)

As a user who typed `@~/development/other-project/README.md` (or any bare path containing `/`) into the prompt, the sandbox for this turn's child processes additionally gets **read-only** access to that file or directory tree.

**Why this priority**: The existing read-bless system is the user's explicit escape hatch; the OS boundary must honor the same user intent or it will constantly block legitimate work.

**Independent test**: Mention `@../shared-libs` in a prompt; a sandboxed `grep`/`cat`/build command reading under that tree succeeds; a write there still fails.

**Acceptance scenarios**:

1. Given the prompt mentions `@/opt/data/dump.json`, when the model runs `shell "jq . /opt/data/dump.json"`, then the read succeeds.
2. Given the same mention, when the model runs `shell "touch /opt/data/x"`, then the write fails (bless = read-only) with a denial hint explaining the read-only nature of blessed roots.
3. Given no mention of a path, when the model runs a command touching that path, then it is invisible/denied exactly as before (blessings are strictly additive and turn-scoped).

### US3 — Escape hatches and visibility (Priority: P2)

As an expert user I can, without editing JSON by hand: see sandbox status (`/sandbox`, `haze doctor`), flip the mode for the current session (`/sandbox off|auto|on`, `strict` profile), add persistent extra read-only/writable roots in settings, and override per run in print mode (`haze -p "…" --sandbox off|auto|on|strict`).

**Why this priority**: Constitution I/VII — expert-oriented, explicit configuration, no silent behavior changes. Broken-by-sandbox workflows must have a fast, documented exit.

**Independent test**: `/sandbox` prints backend, mode, profile, and every root with its access level; `--sandbox off` print-mode run executes a previously blocked command.

**Acceptance scenarios**:

1. Given a blocked command, when the user runs `/sandbox` and follows the printed suggestion (`/sandbox off` or adding a settings root), then the retry succeeds.
2. Given `--sandbox strict` on the CLI, when a command needs network, then it fails with the sandbox denial hint naming the network restriction.
3. Given malformed `sandbox` settings JSON, when haze loads settings, then it fails loudly with the settings path and the offending field (existing settings contract).

### US4 — Truthful diagnostics for the model (Priority: P2)

As the model operating the shell tool, when a command fails because of the sandbox boundary, the tool result carries structured `sandbox` metadata (backend, profile, suspected denial class) and a `suggestedNextStep` that tells me to ask the user to `@mention` the path, extend `sandbox.roRoots`/`rwRoots`, or disable the sandbox — never to work around it.

**Why this priority**: Without this, sandbox denials become opaque `Operation not permitted` failures that waste turns and invite creative (unsafe) workarounds.

**Independent test**: A forced denial produces `reasonCode: 'sandbox_boundary'` + hint; `tests/hazeTools/shell.test.ts` covers the shape.

**Acceptance scenarios**:

1. Given `cat ~/secret-notes.txt` denied by the boundary, the result summary includes the denial class and the suggested next step.
2. Given an ordinary command failure unrelated to the sandbox, no sandbox denial metadata is attached (heuristic must not misfire).

## Cross-Cutting Requirements

- **Settings** (`src/config/settings.ts`): new validated `sandbox` block (Zod, fail-loud, unknown fields preserved). No environment variables (Constitution VII).
- **System prompt** (`src/llm/systemPrompt.ts`): one new rule (`SANDBOX_RULE`) kept aligned with the file-tool secret framing.
- **Result shapes**: `shell` results gain a `sandbox` metadata object; formatters (`src/cli/commands/formatters.ts`) render a one-line status; tool schema/description updated (`src/llm/hazeTools.ts`).
- **Docs**: README section, new `docs/security.html` page, `SECURITY.md`, `CHANGELOG.md`, root + nested `AGENTS.md` contracts, constitution amendment (Principle IV gains an OS-level child-process boundary clause) with a Sync Impact Report.
- **Tests**: unit tests for boundary/profile generation (pure, platform-seamed), gated integration tests for live seatbelt/bwrap behavior (`HAZE_SANDBOX_E2E=1`), existing suite updates.

## Success Metrics

- On macOS 14+ and mainstream Linux (bwrap installed): zero denials for the standard dev loop (`npm ci && npm test`, `git status/diff`, python venv in-workspace) with the default profile.
- 100% of forced out-of-boundary attempts (read sibling project, read `~/.ssh`, write `$HOME`, write `/etc`) fail under both backends.
- No regression in `npm run typecheck && npm test && npm run lint && npm run build`.
