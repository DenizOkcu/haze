# Changelog

## 1.1.0 - 2026-08-19

Theming and secrets. Two user-facing layers landed in this release: a full terminal theme system (14 built-in palettes, live switching, terminal-default adoption) and hard secret-file protection across every file tool.

### Added

- Terminal theming: `src/ui/theme.ts` is the shared palette singleton (semantic roles — accent, command, muted, success/danger pairs, surface backgrounds — resolved through the oh-my-zsh/zsh color vocabulary of zsh names, xterm-256 indices, or `#rrggbb` hex), and `src/ui/themes/` is a one-file-per-theme registry keyed by settings name, seeded with the default `purple` and `light` palettes plus oh-my-zsh ports (`robbyrussell`, `af-magic`, `agnoster`, `bira`, `bureau`, `clean`, `cloud`, `dst`, `fishy`, `solarized-dark`, `solarized-light`, `steeef`). Themes own both terminal defaults: haze adopts the theme's foreground and background via OSC 10/11 at startup and restores them (OSC 110/111) on exit, so light palettes never paint a light canvas under dark-default text. A `theme` key in `~/.haze/settings.json` selects the palette (validated loudly at startup with the valid names listed), and the new `/themes` command switches it: the picker labels each theme light/dark and marks the active one, `/themes <name>` sets one directly, and switching applies live without a restart — already-printed transcript text keeps its old colors (Ink `<Static>` stays as-rendered), which is accepted behavior. The conversion guides for porting oh-my-zsh, VS Code, and Sublime themes live in `src/ui/themes/AGENTS.md`.

- Hard secret-file protection in every file tool: SSH keys (`~/.ssh/**`, `id_*` private keys), shell history files, `.env`/`.envrc` files (excluding `.example`/`.sample`/`.template` documentation variants), `*.pem`/`*.key`, `secrets.{json,yaml,yml,toml}`, and common home credential stores (`~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.git-credentials`, and others; see `src/core/safety/secretPaths.ts`) are refused for reads *and* mutations before any filesystem access. The check covers lexical and real paths (symlink-proof in both directions), wins over user-typed `@path` read blessings and `allowIgnored`, and grep traversal excludes the protected names with negated-only globs appended after any model-supplied glob (a later ripgrep glob takes precedence, so an explicit glob cannot re-include secrets; positive re-include globs would whitelist the search, which is why documentation variants are excluded from traversal but stay readable via targeted `readFile`). Refusals are terminal structured results (`secret_file_protected`, `recoverable: false`, ask-the-user next step, no content echoed) so models do not burn steps retrying, and the transcript shows them as `blocked: protected secret file (path)`, distinct from ordinary failures. The `shell` tool is deliberately not command-filtered: secret avoidance in shell is instructed through the system prompt (`SECRET_FILE_RULE`), aligned with the file-tool refusal wording.

## 1.0.0 - 2026-08-16

The first stable release. The CLI flags, settings schema, `stream-json` event contract, session format, skill layout, and structured tool-result shape are now covered by the 1.x compatibility promise: breaking changes to them require a new major version.

This release was validated with a differential Harbor benchmark (`local/csv-query`, glm-5.3, four harnesses — claude-code, nanocoder, pi, haze — same model and backend): haze 1.0.0 passed 17/17 verifier tests with the fewest input tokens of the reporting harnesses, a clean goal envelope (1 cycle, structured passing validation), and zero stalls; the four defects the benchmark surfaced earlier were all fixed on this line. Full report: `benchmarks/harbor/results/20260816-224944-glm53-differential.html`.

### Added

- Configurable model-retry pool (`modelRetries` setting, integer 0–10, default 2): the shared bounded pool that retries transient model errors and idle-stream stalls is no longer hardcoded. Providers that terminate long streams aggressively (Z.ai's OpenAI-compatible endpoint repeatedly stalled or terminated long streams, exhausting the old fixed pool of 2 and failing a 28-minute benchmark run) can now be given more headroom, and `0` disables automatic retries entirely (stalls pause with the goal preserved for an interactive resume). The effective pool size is reported in `timeout` and `retry` stream events (`maxRetries`) and in stall diagnostics, so headless consumers can see the configured bound.

### Fixed

All four defects below were surfaced by the csv-query differential benchmark (same model across harnesses isolates the harness) and carry regression coverage:

- `writeFile` no longer shadows its own chunking guidance with a cryptic `AI_TypeValidationError`: the input schema previously capped `content` at 16 KiB, so an oversized single-chunk write died at Zod validation before `execute` could return the actionable `write_chunk_too_large` advice (write the first chunk, then `append=true`). Size policy now lives only in `execute`.
- Reads fail open in Git-less workspaces again, restoring the documented contract: `readFile` threw `ignore_check_unavailable` when Git was absent (common in benchmark and container environments) instead of tolerating `unknown` ignore status. Mutations keep failing closed when ignore status is unverifiable.
- The shell validation classifier is no longer JS-toolchain-biased: common Python, Go, Rust, Make, Maven, Gradle, Ruby, .NET, Deno, Bun, and Node test commands now count as bounded validation evidence, and direct, unchained execution of a file changed during the active goal also counts — so a successful `node tool.js … data.csv` run satisfies completion without crediting unrelated shell commands.
- Custom checks are now visible to the completion gate: `shell` accepts `purpose=validation`, producing structured evidence from the real exit result for ad hoc assertion scripts. Missing-validation repair gets one focused slice, rejected summaries leave active model context, and mutation/revision churn no longer extends the goal. Deadline exits preserve cumulative evidence and report `goal-deadline`, not `user-aborted`.

### Changed

- `SECURITY.md` supported-series table now tracks the `1.x` major (security fixes for the latest published release; pre-1.0 versions require an upgrade).

## 0.11.0 - 2026-08-15

### Added

- Runtime provenance and stale-install protection: `npm run build` now embeds `dist/buildInfo.json` (version, commit, build time), and the `bin/haze.js` launcher verifies required compiled modules (including the goal supervisor) and manifest/version/commit consistency before starting — refusing incomplete or stale builds with an actionable rebuild hint instead of running partially outdated code. `haze --version --verbose` prints the executing version, commit, runtime/executable paths, and goal-supervisor state; the new `haze doctor` command reports the same provenance plus artifact/manifest checks, the runtime capability registry (`logicalGoalSupervisor`, `crossTurnCheckpoints`, `automaticBudgetContinuation`), and a warning when a nearby source checkout is newer than the running binary (interactive startup shows the same warning; nothing is ever switched silently). Session headers now record the executing build (version + commit + build time) so saved failures tie to the code that actually ran, every goal start logs "goal supervisor enabled; automatic continuation across physical-turn budgets" in debug output, and `npm run dev:link` builds the checkout, links it globally, and verifies the `haze` on PATH resolves to this checkout's version and commit (the non-global alternative remains `npm run haze -- <args>`).
- Autonomous goal continuation across physical turns: per-turn step/tool budgets no longer end the user's goal, and a voluntary final is no longer accepted as completion while this turn's declared `writeTasks` list has pending/in-progress items or post-mutation validation is missing/stale/failed (implement/fix/test intents) — prose alone is never evidence. A logical-goal supervisor wraps each request — a turn that stops `recoverable-incomplete` at any budget boundary (including `tool-calls` finishes) automatically starts the next continuation turn against the preserved conversation, sharing one mutation lease, seeding cumulative task/validation/mutation evidence so nothing resets at the boundary and completed work is never replayed. It continues while measurable progress occurs and stops only for structured completion, concrete external blockers, user cancellation, the goal deadline, or two consecutive no-progress cycles (the first being the allowed corrective) — never silently discarding recoverable work and never reporting it complete. Interactively, continuation is automatic with a visible "Continuing unfinished goal — cycle N" status and the `R` key is reserved for genuinely paused goals; headless `--timeout` now bounds the whole logical goal, `stream-json` gains `goal_start`/`goal_continue`/`goal_end` events, the JSON result envelope gains cumulative `goal` evidence (cycles, stop reason, total mutations, final validation outcome and task counts), and the exit code stays non-zero unless the goal structurally completed.
- Model-written `/compact` summaries (F-09): manual `/compact` now asks the active model to summarize the older conversation into a continuity summary (goal, decisions, files, validation results, next action), keeping the recent tail verbatim. Set `manualCompaction: "heuristic"` in settings to keep the previous model-free bounded excerpt; automatic mid-turn compaction always uses the heuristic excerpt, and any summarization failure falls back to it.
- Headless `--timeout <duration>` (e.g. `30s`, `10m`, `2h`) sets an absolute turn deadline that bounds total elapsed time; on expiry haze emits a `timeout` stream-json event and exits non-zero. Per-tool execution deadlines (default 10m; 20m for subagents) ensure an uncooperative tool cannot defer a turn indefinitely, with late-settlement quarantine so ignored cancellation cannot mutate state.
- Optional per-provider `modelLimits` metadata (`contextWindowTokens`, `maxOutputTokens`) for request budgeting; `npm run release:verify` checks package/lockfile/README/changelog/SECURITY/docs/AGENTS version agreement in one run (wired into `prepublishOnly`).
- Provider presets now carry curated per-model context-window and output-token limits (from the models.dev catalog, the same source pi and nanocoder use; cross-checked against kilocode and opencode's models.dev exports), and the provider wizard writes them into the provider's `modelLimits` settings when a suggested model is added — so request budgeting uses the real window instead of the conservative 32K fallback without any user configuration. Limits are per-preset because aggregators may cap context below the origin model (e.g. Together serves DeepSeek-V4-Pro at 512K vs DeepSeek's own 1M); a drift-guard test keeps every suggested model on every hosted preset covered. Suggested model lists were refreshed to current releases (e.g. gpt-5.6 family, gemini-3.7-flash, claude-opus-5, grok-4.6, glm-5.3, kimi-k3, Qwen3.7-Max, Qwen3.8-2.4t, thinkingmachines/Inkling, nemotron-3.5-lightning, deepseek-v4-pro-0813) and stale/deprecated ids (o4-mini, devstral-2512, qwen3-32b) were replaced. Poe's suggested ids were corrected to its provider-prefixed form (`anthropic/claude-opus-4.8`, not `claude-opus-4.8`). New curated gateway presets: Kilo Gateway, Novita AI, Deep Infra, SiliconFlow, and Nebius AI Studio (all OpenAI-compatible endpoints with their conventional API-key env vars).

### Changed

- Session files no longer grow quadratically over long sessions (F-03): snapshots rewrite the full conversation history each turn, so a long session cost O(turns × history) bytes on disk. Once superseded snapshots dominate the file (16 MB by default), haze atomically rewrites it keeping only the newest conversation/work-state snapshots plus all small entries; restore semantics are unchanged and browsing history (ui messages, events) is preserved.
- The completion-rescue slice now also covers `test`-intent requests (F-04): a long test-orchestration turn that exhausts the tool-only boundary without a substantive answer gets the same bounded rescue slice as implement/fix requests, gated by the shared `intentExpectsValidation` policy.
- Headless print mode now self-heals from provider context overflows (F-10): `-p` runs compact the loaded conversation once and retry, like the interactive path. When compaction is unavailable, the error message says so explicitly instead of the misleading "not enough conversation history".
- Mutation tools fail closed when Git cannot run (F-05): ignore checks for `editFile`/`writeFile`/`replaceLines` now distinguish "checked and not ignored" from "could not check". Reads still fail open, but writes into a workspace where ignore status is unverifiable (missing/broken Git) are refused with `ignore_check_unavailable` unless `allowIgnored=true` is set explicitly.
- Per-step request estimation is memoized per message object (F-07): `prepareStep` no longer re-stringifies the entire message history on every provider call, removing the O(history) CPU cost per step on very long turns.
- A rescue slice with no qualifying built-in mutation/validation tools now forces a tool-free synthesis step instead of silently keeping the full tool set (F-08), preserving the "rescue never reopens discovery" invariant when builtins have been removed.
- The provider wizard warns when a ChatGPT sign-in provider's configured URL diverges from the canonical Codex endpoint (F-14) — requests always route to the registered endpoint — and typing the canonical Codex URL during a custom add now points at the OpenAI Subscription preset.
- README and docs now state the supervision model prominently (no sandbox or permission layer; not an unattended runtime), the fixed OAuth callback port 1455 that can block ChatGPT sign-in, and the crash-recovery granularity: sessions persist at turn boundaries, so after a mid-turn crash resume replays from the last completed turn and the working tree should be verified with git (F-02/F-06/F-11).
- The conservative context-window fallback for models without metadata is now 128K (the modern floor for capable hosted models) instead of 32K, and unknown models on localhost inference servers keep the smaller 32K default because their effective window is set by server configuration (often 4–32K) and silent truncation there is undetectable. Both fallbacks are user-configurable in settings (`contextWindowFallbackTokens`, `localContextWindowFallbackTokens`); unset means the built-in defaults. The guess is observable: every turn emits a `context_budget` stream event (`contextWindowTokens`, `source: settings|user-fallback|default-fallback`), and interactively a system message — shown only when the built-in default was used, since a user-set fallback is an intentional choice — names the model and how to correct it. The warning is gated per model: it appears at the start of a session and once after a model switch, never on every turn.
- The context-fallback warning is now genuinely once-per-session per model: it previously reappeared on every turn because the per-session warned flag lived on a throwaway object. A stable in-memory session object carries the last warned `provider:model` key, so the same model stays silent for the rest of the session and a switched-to fallback model warns exactly once at its first turn.
- Provider wizard model discovery now harvests non-standard context/output fields from the OpenAI-compatible `/models` listing (OpenRouter `context_length`, Groq `context_window`, LM Studio `max_context_length`, `max_output_tokens`/`max_completion_tokens`/`max_tokens`), sanity-clamped to plausible token ranges. Harvested values are written into the provider's `modelLimits` when the model is added and win over the static preset catalog (live provider data beats the catalog; user-configured keys still win over both). Ollama reports nothing in `/v1/models`, so the wizard additionally probes its native API at save time for loopback URLs: the actually-loaded runtime context from `/api/ps` first, an explicit Modelfile `num_ctx` from `/api/show` second, and the model's declared maximum capped at the user's local fallback setting (default 32K) last (Ollama auto-sizes the effective window to available VRAM, and over-trusting the declared maximum would risk silent truncation). Unknown models stay on the fallback and its warning.
- Performance and long-running-autonomous hardening: `listFiles` discovery now uses one bounded `git check-ignore` batch per directory level instead of one Git subprocess per walked entry, and cursor pagination no longer re-checks entries that preceded the cursor. LSP navigation (symbols/definition/references/workspace symbols) reuses a single initialized language server and its opened documents per turn instead of restarting and reindexing on every call. `/fleet` subagents now let read-only work fill idle slots behind one blocked mutation (bounded so a serialized mutation is never starved). Session conversation/work-state snapshots are coalesced so a long turn does not rewrite the full history on every update. The interactive transcript caches settled Markdown root chunks so it no longer re-lexes the whole history on each render.
- Main tool-call budgets are now enforced atomically at the execution boundary, so one oversized parallel batch cannot overshoot the turn or recovery-slice limit; blocked calls have no side effect and force a final synthesis.
- Context budgeting is now model-aware: the message allowance is the configured context window minus the system prompt, tool schemas, output reserve, and a safety margin (no longer a fixed 40K). Long multi-step turns compact accumulated tool history before each provider request, and context-overflow retries shrink the target progressively.
- `--output stream-json` now emits `message_update` deltas (not cumulative text) through an ordered, backpressure-aware NDJSON sink, so total update payload stays linear in the final response size; `message_end.text` remains complete and authoritative.
- A stalled model stream no longer discards unfinished work as a generic user abort. Abort causes are typed (user cancel, turn deadline, model-stream idle) so each path gets its own message and outcome. An idle stall with no emitted step output retries through the bounded model-retry pool, salvaging the conversation to the last completed step so mutating tool work is never re-run; when retries are exhausted or the stalled step emitted partial output, the turn pauses with the active goal preserved and chat offers a one-key `R` resume instead of a restate. Stall diagnostics (provider/model, last stream event, emission state, retry eligibility) surface in the timeout event, debug log, and debug panel as metadata only.

### Fixed

- Streaming no longer flickers or erases scrollback: the live frame now renders incrementally (only changed lines are rewritten, capped at 15 fps to match the spinner cadence), and the dynamic tail (streaming roots, live tool groups, task bar) is clamped to a viewport-derived row budget with row estimates mirroring Ink's own `wrap-ansi` wrapping — so Ink never enters its scrollback-wiping overflow path even when the live region outgrows the terminal height. `wrap-ansi` (already in the tree via Ink) becomes a direct dependency.
- Provider normalization no longer strips user-configured `modelLimits` from settings: `normalizeProvider` whitelisted name/url/key/kind/capabilities/models only, so limits configured in `settings.json` were silently dropped before model resolution ever saw them.
- Build-provenance reads work again: an inverted cache sentinel made the default-path `readBuildInfo()` return before ever reading `dist/buildInfo.json`, so `haze --version --verbose` printed `commit: unknown` and session headers never recorded the executing build (`haze doctor`, which probes explicit candidate paths, was unaffected). The default path now loads and caches correctly and has regression coverage.
- The print-mode help text no longer claims "there is no automatic context-overflow recovery"; it now describes the actual behavior (compact the conversation and retry once, with an explicit error when compaction is unavailable), matching the README and the implementation.
- Dependency refresh (nanoid 3.3.17 → 3.3.18 for GHSA-2v37-7h3g-55p8, esbuild 0.28.1 → 0.28.2, @ai-sdk/mcp 2.0.31 → 2.0.32) keeps `npm audit --audit-level=high` and CI green, and CI caps vitest workers for a deterministic suite.

## 0.10.1 - 2026-08-13

### Added

- Added OpenAI Subscription provider preset with browser OAuth against the ChatGPT Codex Responses endpoint. Credentials live in `~/.haze/auth.json` with private permissions and are refreshed transparently near expiry; the chatgpt-codex provider kind routes all requests to the canonical Codex URL with the account-id header attached.
- Added `SECURITY.md` with the supported-version policy, private reporting route, response expectations, and attended-use threat model.
- Added regression coverage for external prompt-injection framing, fetch deadlines and transport behavior, oversized stdin, tampered sessions, unsafe log ids, C1 terminal controls, Windows process-tree signaling, and shared UTF-8 boundaries.

### Changed

- The interactive transcript uses Ink static output for the header, completed messages, and parser-stable root-level Markdown blocks from an active response. Only the unfinished root block and live controls rerender, reducing terminal flicker and scroll jumps without rendering incomplete Markdown as if it were finished.
- New interactive sessions stay in memory until the first non-empty UI message or conversation snapshot. Empty sessions no longer create JSONL files, and zero-message files from earlier versions are omitted from `/resume`, `--continue`, and latest-session selection.
- Added bounded completion recovery for long turns: one output-length continuation and one final mutation/validation rescue slice, both counted against turn-wide budgets. Headless results and lifecycle events now include safe completion and validation evidence.
- File mutation tools now render compact colorized diffs, with first/last previews and retained handles for large changes.
- Updated runtime and development dependencies to current releases while keeping TypeScript pinned at 6.0.3; the full dependency audit reports zero vulnerabilities.
- Replaced the single-page docs site with a multi-page redesign (landing, quickstart, commands, tools, skills, workflows) backed by shared CSS/JS.
- Documented the public contracts for CLI flags, slash commands, tool result shapes, settings and session files, Markdown skill packages, and the Node.js 22 support floor.
- CI now runs typecheck, tests, lint, build, `npm audit --audit-level=high`, and `npm pack --dry-run` on Node 22 and 24. Explicit `any` is now a lint error.
- Consolidated UTF-8-safe byte truncation, package-version loading, and platform external-opening helpers. Known tool-context fields now receive light runtime type validation.
- Refined the terminal palette, startup guidance, system-message formatting, task display, and session startup grouping.
- Session-picker summaries are cached by file size and modification time. Windows graceful and forced termination both target the complete process tree.
- `writeFile` now enforces a 16 KiB per-call cap at both the Zod schema and the runtime body. Malformed tool input triggers up to two smaller retries before the turn is reported as blocked with an unresolved-tool-input marker.

### Security

- Main and subagent prompts now treat ordinary tool output as untrusted data rather than instructions, including fetched pages, MCP/LSP output, and file content outside the workspace.
- Documented that bash classification is informational, command confirmation gates are intentionally absent, and haze is intended for supervised use by experienced developers.
- Documented that `--debug` logs can contain secrets and file contents and must be reviewed before sharing.
- Session JSONL readers reject structurally invalid entries, log readers reject traversal-shaped ids, and terminal titles strip C0 and C1 control characters.

### Fixed

- Fast providers can no longer outrun edit-recovery state and leave the following step restricted to `readFile`. Recovery now advances in the AI SDK's ordered step callback, and equivalent lexical paths such as `a.ts` and `./a.ts` satisfy the reread requirement.
- Read-only recovery now activates only for structured mutation failures that explicitly request `readFile`; argument-only `writeFile` failures can be retried directly with corrected input.
- Repeated identical calls suppress a tool only for the immediately following step instead of removing that tool for the remainder of the turn.
- `readFile` failures provide bounded reason codes, suggested paths, and actionable recovery guidance. Streaming diagnostics consistently expose safe built-in failure details without leaking third-party output.
- Fetch now cancels redirect bodies, enforces one total redirect deadline, rejects non-streamable bodies instead of buffering them without a cap, normalizes array response headers, and rejects request bodies, unsupported methods, and URL credentials in the pinned transport.
- Piped stdin is capped at 256 KiB and oversized prompts fail with guidance to pass a file path instead. Non-TTY pipes are detected correctly.
- Bounded process collectors continue draining discarded bytes after their retention cap so chatty children can exit without filling their pipes.

## 0.10.0 - 2026-08-03

### Added

- Added image input for png/jpeg/gif/webp files mentioned with `@path` or a slash-containing bare path. Providers must be explicitly marked image-capable; each message is limited to four images and 5 MB per image, and resumed sessions store placeholders instead of bytes.
- Added turn-scoped read blessings for user-typed file and directory paths, including host paths outside the workspace. `@` autocomplete browses gitignore-aware workspace paths. Mutating tools never honor the read exception.
- Added context-isolated subagents with explicit modes, profiles, models, deadlines, concurrency, tool budgets, cancellation quarantine, and shared mutation coordination. `/fleet` exposes parallel-only decomposition with temporary `--review`, `--profile`, `--workers`, and `--concurrency` options.
- Added managed background processes for up to five dev servers or watchers. Rolling output stays byte-bounded and retrievable by handle; the `process` tool lists, reads, and kills registrations, and haze tears down all process trees on session reset or exit.
- Added a workspace session browser to `/resume`, including resume-in-place and fork-from-snapshot actions. Session headers record fork provenance.
- Added live model discovery from OpenAI-compatible `/models` endpoints to `/model` and provider setup, with curated models pinned when served and manual entry retained as fallback. Expanded the provider preset catalog.
- Added project-local Markdown skills under `.haze/skills`. Project skills are labeled as untrusted repository content, override same-named global skills, remain real-path-confined, and can be managed independently by scope.
- Added rotating busy-state tips, toggled with `/tips`, cursor-aware `@` completion, and a TTY-only `haze - <cwd>` terminal title.
- Added the spec-kit workspace and project constitution.

### Changed

- Bash tool results carry byte statistics instead of duplicating retained stream text into model context; raw retrieval by handle is unchanged.
- `/compact` now builds a bounded recent-first excerpt and reports omitted entries rather than embedding unbounded collapsed text.
- `readToolOutput` eviction is true LRU: reading an entry refreshes its recency.
- Session IDs include a random suffix to avoid same-millisecond collisions. Session restore reads conversation and work state in one scan.
- Headless `--debug` progress uses stderr; the undocumented `HAZE_DEBUG` environment variable was removed.
- Branch display refreshes every 15 seconds and after each turn. Chat session and wizard orchestration were split into focused helpers without changing public flows.

### Security

- Project skills and their references remain real-path-confined to the workspace and are framed as untrusted repository content before entering model context.
- User-typed host paths grant read access only for the current turn. Mutating tools never honor the blessing set.
- Grep now shares bash's bounded process-group teardown, including `SIGTERM` to `SIGKILL` escalation and a close fallback for retained output pipes.
- Managed background processes keep byte-bounded rolling output and are terminated as process trees on session reset or haze exit.

### Fixed

- Subagent synthesis retains the task and gathered tool results, and long active worker waves no longer trip the idle timer. Flat required tool input avoids empty union-schema calls from local providers.
- Bash results no longer duplicate retained stream text into model context. Raw output remains available by handle.
- `/clear` prints once. Malformed `.haze/tasks.json` loads as an empty list. Retry classification matches status codes as whole words.
- `readFile` outline paging no longer skips entries after output truncation. Session files slim large mutation inputs to path and byte counts.
- Fetch derives its user agent from `package.json`, and session restore reads conversation and work state in one pass.

## 0.9.0 - 2026-07-10

### Security

- Private haze state now uses `0700` directories and `0600` files on POSIX. Bash/process output, raw-output handles, file reads, edits, LSP documents/frames, grep, and JSONL readers enforce collection-time byte limits; bash timeout/abort terminates process trees.
- Grep rejects explicitly ignored roots unless requested, skills and LSP enforce real workspace/root boundaries, MCP discovery and cleanup are bounded and abort-aware, and credentials are rejected on remote plaintext HTTP endpoints.

### Fixed

- Turn/tool status is authoritative across UI, events, logs, sessions, and headless output; retries expose one turn lifecycle and structured `{ok:false}` results remain failures.
- Session/debug persistence is ordered and flushable, invalid skills are isolated, malformed settings remain visible, active provider/model removal clears selection, and stdio MCP setup no longer asks for HTTP headers.

## 0.8.0 - 2026-07-09

### Changed

- Migrated the main `ToolLoopAgent` turn and subagent runner to AI SDK v7 while preserving compact terminal output, turn-scoped tool state, loop guardrails, and scoped context injection.
- Added the active model, a one-second elapsed timer, and current tool activity to the busy line. Activity labels cover reading, editing, searching, commands, skills, LSP, and MCP tools. Long waits during model and tool calls now show visible progress.
- Applied stricter bounds to large bash output before it enters the transcript or model context, especially for validation, search, and log-heavy commands.
- Updated tool context wiring, maintenance prompts, and agent guidance for AI SDK v7 and the current runtime.
- Standardized the lowercase `haze` name across the README, docs, prompts, skills, command help, tests, and agent guidance.

### Fixed

- Fixed multiline input shortcut handling in the chat input.
- Kept model thinking labels concise without hiding useful slash-model suffixes such as reasoning variants.
- Compacted long file paths in live tool labels so the busy line stays readable.

## 0.7.0 - 2026-06-29

### Added

- Added `--output stream-json` to print mode. `haze -p "…" --output stream-json` writes public progress events to stdout as newline-delimited JSON, followed by the same `{type,status,result,usage}` envelope as `--output json`. Each event has an ISO-8601 `at` timestamp. Tool events omit raw inputs and outputs so CI and harness logs do not capture them. Before this option, print mode stayed silent until it returned the final envelope; harnesses could not show live progress or detect stagnant and looping runs from stdout. Every line is valid JSON and can be piped through `jq -c .`. The `text` and `json` formats are unchanged.
- The startup message now lists the context files sent with the system prompt. This makes it possible to check whether haze loaded global `CLAUDE.md` or `AGENTS.md` files and workspace instructions.

### Changed

- `haze -p "prompt"` runs one non-interactive turn and prints the result. It supports a per-run `--model provider:name` override without changing settings, plus structured `--output json` output. It reads piped prompts from stdin. Exit codes and JSON status come from the agent's terminal state (`complete`, `aborted`, or `failed`) rather than parsed reply text. Invalid or ambiguous model selectors print a specific error and exit nonzero. `--debug` writes a JSONL log under `~/.haze/logs/`, and the JSON `usage` object has a documented, fixed set of fields.
- Nested `CLAUDE.md` and `AGENTS.md` files discovered during a turn are added to the next model step and reread when their signature changes. haze serializes concurrent discovery so it reads unchanged files once without missing updated instructions.
- Session persistence no longer stores streaming `message_update` events. Large outputs and errors in saved `tool_end` events and `conversation_snapshot` tool results are reduced to previews and byte counts. Sessions remain resumable without unchecked JSONL growth from repeated text streams or large file reads.

### Security

- Closed a DNS-rebinding TOCTOU issue in `fetch`. `urlGuard.validateUrl` checked that a hostname resolved only to public addresses, but the global `fetch` resolved it again when connecting. An attacker-controlled DNS server could therefore return a public IP during validation and an internal or cloud-metadata IP during connection. `fetchUrlContent` now pins each connection and redirect hop to the validated IP with a small standard-library transport. It preserves the original `Host` header, TLS `servername`, and certificate verification without another DNS lookup. The redundant post-fetch validation was removed. Literal IP URLs still use the global `fetch` because they have no DNS-rebinding surface.

## 0.6.0 - 2026-06-21

### Added

- Added [Model Context Protocol](https://modelcontextprotocol.io) server support. `/mcp` opens an interactive picker for presets or custom `http`, `sse`, and `stdio` servers. Context7 is included as a preset for current library documentation. From the picker, users can enable, disable, or remove a server and set a masked API key. Configuration is stored under `mcpServers` in `~/.haze/settings.json`. MCP clients open for each agent turn and close afterward. A failing server is isolated, and MCP tools cannot shadow built-ins.
- Added optional configurable stdio LSP support through `/lsp`, with TypeScript, Rust, Python, Go, and PHP presets.
- Added read-only semantic navigation tools (`lspWorkspaceSymbols`, `lspSymbols`, `lspDefinition`, `lspReferences`) that are exposed to the model only when an enabled LSP command is installed on `PATH`.
- Added `/context`, a token breakdown of the current request (system prompt, project context, tools including MCP, and chat messages).
- Added `/settings open` to open `~/.haze/settings.json` with the OS default app.
- Added a non-blocking startup update check (throttled to once per 24 h via `~/.haze/updateCheck.json`) that surfaces a newer published version when one exists; every failure mode resolves silently.

### Changed

- Switched the main agent turn to the AI SDK v6 `ToolLoopAgent` abstraction while preserving compact terminal tool and text rendering and the existing loop guardrails.
- Improved transcript segmentation so assistant text and tool blocks alternate cleanly during multi-step turns.
- Added LSP-aware prompt guidance only when LSP tools are actually available; otherwise haze naturally falls back to `grep`, `listFiles`, and `readFile`.
- Made `/lsp` and `/mcp` interactive pickers matching the `/provider` flow (autocomplete lists, preset pickers, masked API-key entry), replacing the previous `/lsp`/`/mcp` subcommand syntax.
- Unified skill management into a single `/skills` interactive picker that mirrors `/provider`, `/lsp`, and `/mcp`; removed the legacy `/create-skill`, `/skill-info`, `/validate-skill`, and `/remove-skill` commands.
- Updated README, docs site, and project agent guidance for LSP setup and the 0.6.0 release.

## 0.5.0 - 2026-06-19

### Changed

- Removed all user-facing environment variables. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `HAZE_MODEL`, and `HAZE_CONTEXT_BUDGET_SHARE` are no longer read; configure providers, models, API keys, and base URLs through `~/.haze/settings.json` and the `/provider`, `/model`, `/settings` slash commands instead. This also removes the `OPENAI_*` env overrides from the startup provider info and the header.
- File-based LLM logging is now off by default. Previously, every session wrote a detailed JSONL log containing full prompts, model messages, tool inputs and outputs, and token usage to `~/.haze/logs/<timestamp>.jsonl`. Run `haze --debug` to enable logging and the on-screen debug panel. `/logs` still opens historical log files.
- Bash results now pass through command-aware reducers before they enter the transcript/model context. Validation failures render focused diagnostics, successful validation stays short, git/diff/search/JSON/log-like output is compacted, noisy command families get line filters, and reduced raw output remains retrievable by `readToolOutput` when stored.
- `grep` now returns compact structured search output for long match sets/lines, with reduction metadata, omitted-result counts, and a raw-output handle when the rendered result was truncated.
- Tool activity rendering is quieter: live tool groups show elapsed timers, subagent child calls, capped group detail, and compact success/failure summaries instead of dumping large result objects.
- Assistant Markdown rendering in the CLI now supports styled headings, inline code/strong/emphasis/links, blockquotes, syntax-highlighted code fences, horizontal rules, and width-aware tables.
- Consecutive assistant messages in one turn now share a single visible `haze` header for a less noisy transcript.
- Completed task lists now clear automatically at the start of a new user turn so old successful todos do not linger in the task bar.
- Context loading now includes global `~/.claude/CLAUDE.md` while keeping `~/.haze/AGENTS.md` higher priority for haze-specific global guidance.
- Nested `CLAUDE.md`/`AGENTS.md` files below the workspace are now scoped and loaded lazily when file tools operate inside their directory tree; mutating file tools stop before the first edit when newly scoped instructions are discovered.
- Repeated identical tool calls are now steered back to the model with an explicit correction instead of aborting the turn immediately, so haze can reuse existing results or finish cleanly.
- `/init` now explicitly keeps `AGENTS.md` compact, reminds the model that context files are injected into every request, and references the current context-file truncation budget.

### Added

- `fetch` tool: read public URLs as readable content (Markdown for HTML, pretty JSON for JSON, passthrough text), with SSRF protection (scheme allowlist + private/loopback/link-local/metadata blocking, re-validated per redirect and after DNS resolution), a 2 MB raw-download cap, and a 30 s timeout. Oversize output stays retrievable via `readToolOutput`. HTML→Markdown extraction uses `defuddle` (readability-grade, pure-JS DOM).
- Shared tool-output reduction metadata (`reducerName`, `contentKind`, `lossy`, `parseTier`, token/character savings, handles, omitted counts) for reduced tool results.

### Removed

- Removed obsolete token-efficiency planning documents and the unused alternate docs-site HTML file from `docs/`.

## 0.4.0 - 2026-06-15

### Skills

- Replaced single-shot `/create-skill <description>` with a three-step interactive wizard: name → optional role → description. The wizard uses the supplied name and role verbatim; the model no longer renames them.
- Added language-agnostic intent extraction. Skill descriptions are interpreted by the model in any language, replacing the previous English-only regex strip. `"crée une compétence qui vérifie le style du code"` now produces a skill that vérifies code style, not a skill about creating something.
- Added `toSkillDirName` for kebab-casing user-typed skill names without stop-word stripping (so `"create a skill"` stays `create-a-skill`, not `skill`).

### Commands

- Removed the `/tasks` slash command. The model now manages tasks through `writeTasks`. `/clear` still removes them when it clears the conversation.
- Removed the `/list-skills` alias; `/skills` now shows the overview and the installed list.
- Removed the `/skill <subcommand>` and `/skills <subcommand>` legacy routing forms. Each skill operation now has exactly one user-facing form: `/skills`, `/create-skill`, `/skill-info`, `/validate-skill`, `/remove-skill`.
- Removed the `/tasks rm` alias for `/tasks remove`.
- Refactored `handleSkillCommand` from stringly-typed `value` parsing to a typed `SkillSubcommand` union argument.

### Docs site

- Added §02 "Native skill creation" segment that frames the 3-step wizard as the haze superpower, with a live transcript of the wizard prompts, superpower bullets, and copy-pasteable recipe cards for `/code-review`, `/deploy-check`, `/release-prep`, `/security-review`.
- Added §07 "Commands index," a categorized reference for all 16 slash commands and dynamic `/<skill-name>` invocations.
- Removed §04 "Serviceable procedures" (folded into §02).
- Renumbered sections sequentially (§01 Operation → §02 Native skill creation → §03 Field behavior → §04 Components → §05 Compatibility → §06 Install → §07 Commands index).
- Fixed §01 layout: switched from `.container-prose` (narrow, visually centered) to `.container` so it aligns with every other section.
- Updated all `/create-skill <description>` references to reflect the wizard.

### Internal

- Added request-level context accounting, cache/no-cache usage metrics, a debug token breakdown, and an offline `context:report` command.
- Bounded `readFile`, structured and globally capped `grep`, and compacted large bash output behind paginated `readToolOutput` handles.
- Added structured `WorkState` snapshots, token-aware compaction, conservative old-tool-result pruning, bounded continuation slices, and no-progress termination for long agent workflows.
- Made haze control nudges ephemeral, omitted tool schemas from text-only follow-ups, and replaced duplicated subagent prompting with a concise dedicated prompt.
- Consolidated installed workflows into one progressive `skill` catalog tool and added provider capability-gated cache keys, sticky session hints, and low-verbosity options.
- Shortened the model operating contract and final-response guidance while preserving edit recovery, validation evidence, and blocked/partial reporting.

## 0.3.0 - 2026-06-10

- Redesigned docs site with cleaner layout, improved typography, better mobile responsiveness, scroll-reveal animations, skip-link accessibility, and refreshed content structure.
- Moved the task bar above the activity spinner so in-progress and pending tasks are visible during active agent turns.
- Tasks are now automatically cleared when starting or exiting a session, preventing stale task state across sessions.
- Renamed internal `TaskBar` component to `TaskBarContent` for clarity.

## 0.2.0 - 2026-06-07

- Improved coding-loop reliability with stronger continuation behavior after failed edits, failed validation, missing validation, tool-budget interruptions, and incomplete assistant responses.
- Added structured bash command classification for read-only, mutating, destructive, network, validation, and unknown commands, with cwd, duration, timeout, and classification metadata in bash results.
- Added validation-output parsing for common test, typecheck, lint, and build commands, including failed files, failed tests, diagnostics, summaries, and suggested next steps.
- Added shared structured tool result types and more specific file-edit failure reason codes so edit recovery can reread the affected file and retry with better guidance.
- Reworked the system prompt, subagent prompt, compaction prompt, and generated-skill guidance around autonomous expert developer workflows with concise final status reporting.
- Removed hard-coded `temperature: 0` from model calls so providers/models that reject temperature options can run without warning workarounds.
- Removed bash confirmation gates, including for destructive classifications; haze now assumes expert users know what they asked for and relies on transparent tool output rather than permission prompts.
- Improved chat input editing with wrapped multi-line display, vertical cursor movement across wrapped lines, and better cursor mapping for compacted paste blocks.
- Added and updated tests for bash classification, bash execution behavior, validation parsing, edit recovery, system-prompt guidance, and skill generation.

## 0.1.1 - 2026-06-07

- Bundled ripgrep with `@vscode/ripgrep` and updated the `grep` tool to use the package-provided binary path, removing the requirement for users to install `rg` separately or expose it on `PATH`.
- Updated release documentation and site copy for the 0.1.1 patch release.

## 0.1.0 - 2026-06-07

- Added ripgrep-backed `grep` for fast workspace search with regex, glob, context-line, case-insensitive, and result-limit options.
- Added focused `subagent` delegation for independent parallel tasks with fresh context, step caps, concise summaries, tool-call metadata, and parent abort propagation.
- Added compact inline diff display for successful `editFile` and `replaceLines` calls, including added/removed counts, colored additions/removals, one context line around small changes, and hidden summaries for large diffs.
- Improved agent-loop completion handling for truncated model output and long-running tool loops.
- Refined subagent prompting and parent transcript summaries to reduce noise and discourage single-task delegation.
- Updated release documentation and roadmap state for the 0.1.0 foundation release.

## 0.0.3 - 2026-06-06

- Added stable transcript rendering for long sessions, compact placeholders for large multiline pastes, and clearer goal/status display.
- Added OpenAI-compatible provider management with `/provider`, provider-qualified model selection, and legacy OpenRouter settings migration.
- Added durable workspace sessions with `haze --continue`, `--no-session`, `/session`, `/resume`, `/new`, and `/compact`.
- Added context compaction and goal-aware completion tracking to improve long-running agent turns.
- Hardened file tools with structured recoverable failures, safer concurrent mutation handling, line-number-prefix tolerant edits, and EOF-clamped line replacements.
- Simplified generated skill structure around role, focused prompt, and compact output templates.
- Updated docs site install/version copy and refreshed dependencies.

## 0.0.2 - 2026-06-01

- Reworked skills into Markdown-first workflows stored in `~/.haze/skills/<name>/SKILL.md`.
- Added LLM-generated `/skill create <description>` for creating workflow skills from natural language.
- Exposed installed skills as model-selectable `skill_*` tools and slash-invokable commands.
- Added slash-command and skill autocomplete with `Tab` completion.
- Grouped tool calls into compact per-turn activity blocks.
- Added `listFiles` cursor pagination for large recursive listings.
- Refined startup/onboarding UI with ASCII logo, status bar, model/workspace details, and clearer setup guidance.
- Updated README for the minimal LLM harness and adaptive skill workflow.
- Removed old YAML/executable skill tooling.

## 0.0.1 - 2026-05-31

Initial public release.

- Interactive terminal chat CLI for agentic app-building workflows.
- OpenRouter-compatible model configuration via `/login`, `/model`, and environment variables.
- Vercel AI SDK tool calling with multi-step agent execution.
- Transparent tool call display in the chat transcript.
- Workspace file tools: list, read, exact edit, line-range replace, and write.
- `.gitignore`-aware file access with explicit ignored-file overrides when needed.
- Bash tool for tests, builds, and shell commands.
- Persistent input history in `~/.haze/history/input-history.json`.
- Skill management commands for listing, inspecting, validating, installing, and building file-based skills.
- Debug mode via `haze --debug`.
