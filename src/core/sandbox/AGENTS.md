# src/core/sandbox/AGENTS.md

Last updated: 2026-10-16 for the OS sandbox feature (specs/os-sandbox).

OS-level filesystem boundaries for model-initiated child processes: Seatbelt
(`sandbox-exec`) on macOS and bubblewrap (`bwrap`) on Linux.

## Modules

- `boundary.ts` — pure policy: which absolute paths are read-write /
  read-only for sandboxed children. Roots come ONLY from user intent: the
  workspace root, temp/cache dirs, `~/.haze` + `~/.claude` config dirs
  (read-only, credential files masked), system tool dirs, the turn's
  user-typed `@path` blessings, and `sandbox.roRoots`/`rwRoots` settings.
  Never from tool input — the model cannot grow its own boundary. All roots
  are canonicalized (nearest existing ancestor for not-yet-created paths);
  seatbelt matches canonically (`/tmp` → `/private/tmp`).
- `seatbelt.ts` / `bubblewrap.ts` — pure generators (SBPL profile text /
  bwrap argv). Deterministic ordering; snapshot tests pin it. bwrap mask
  ordering is contractual: `--tmpfs $HOME` → dir binds → `/dev/null` file
  masks and `--tmpfs` dir masks AFTER their owning bind.
- `detect.ts` — the ONLY effectful module: bounded one-shot backend probes
  (availability is probed, never assumed — Apple deprecates `sandbox-exec`,
  Ubuntu restricts unprivileged userns), process-scoped cache with
  `resetSandboxDetection()` test seam.
- `runner.ts` — mode resolution (CLI `--sandbox` → session `/sandbox`
  override → settings → default `auto`/`workspace`, mirroring `--reasoning`)
  and `wrapInvocation`. `mode: "on"` without a backend fails closed.
- `diagnostics.ts` — conservative post-hoc denial classification (EPERM/EROFS
  classes; ENOENT only for host-existing paths outside the boundary). Must
  never blame the sandbox for unrelated failures.

## Contracts

- `runBoundedProcess` stays policy-free: callers wrap spawn targets via
  `wrapInvocation` and pass the result to the unchanged primitive
  (timeout/abort/process-group teardown semantics are not renegotiated here).
- The boundary is built once per attempt in
  `cli/commands/streaming/attemptSetup.ts` (after `blessedPaths` resolution)
  and rides the tool context as `sandboxRuntime`. Workers inherit the
  main-turn boundary via the subagent tool — never weaker, and worker input
  text does NOT create blessings (only main-prompt user typing does).
- Blessed paths are read-only at the OS level, mirroring the file-tool rule
  that the bless set never grants mutation. Secret paths are dropped from
  blessings and settings roots; secret protection (`core/safety/secretPaths`)
  wins over every root, exactly like `workspaceFile.ts`.
- Credential masks cover `~/.haze/settings.json`, `~/.haze/sessions`,
  `~/.haze/logs`, `~/.haze/history`, and `~/.claude/.credentials.json`,
  `settings*.json`, `projects/`. Workspace-internal secret files (e.g.
  `.env`) are deliberately NOT masked — `source .env` is a legitimate
  workflow; the file-tool refusal and `SECRET_FILE_RULE` in
  `llm/systemPrompt.ts` own that layer. Keep both aligned when either list
  changes (root AGENTS.md contract).
- No LSP/MCP sandboxing (v1 decision): they are user-configured
  infrastructure, not model-chosen commands.
- Windows: backend `none`; `auto` degrades with one visible notice per
  session; `on` fails closed with an actionable remedy.

## Tests

- `tests/core/sandbox/**` — unit (boundary/backends/detect/runner/diagnostics)
  with injected runtime facts/spawn seams, plus the live e2e matrix gated on
  `HAZE_SANDBOX_E2E=1` + probe success (never asserts on real secret
  contents).
