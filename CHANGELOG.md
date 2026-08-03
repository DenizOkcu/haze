# Changelog

## Unreleased

### Changed

- Bash tool results carry byte statistics (`totalBytes`/`retainedBytes`/`omittedBytes`) instead of the raw retained stream text, so large outputs no longer duplicate into the model context. Retrieval by handle is unchanged.
- `/compact` now condenses older messages into a bounded excerpt (most recent older messages first) and reports omitted entries, instead of embedding unbounded whitespace-collapsed text.
- `readToolOutput` handles evict least-recently-used: reading an entry protects it until it becomes the oldest again.
- Session IDs carry a short random suffix after the timestamp, so sessions created in the same millisecond no longer collide; newest-first ordering is unchanged.
- Headless `haze -p ... --debug` prints `[haze]` progress lines on stderr. The undocumented `HAZE_DEBUG` environment variable is gone.
- Branch display refreshes every 15s plus once after each turn instead of every 3s.

### Fixed

- `/clear` prints its "Cleared." message once.
- Malformed or partially written `.haze/tasks.json` files load as an empty task list instead of passing unvalidated JSON to the UI.
- Retry classification matches HTTP status codes as whole words, so messages like "processed 5000 files" are no longer treated as transient provider errors.
- `readFile` outline paging resumes after the last included entry when the output cap truncates a page instead of skipping entries.
- Session files no longer persist full `writeFile`/`editFile` inputs in `tool_start` events; inputs are slimmed to byte counts (and path).
- Resuming a session scans the session file once instead of twice.
- grep inherits the hardened bounded-process teardown (process group, `SIGTERM`→`SIGKILL` escalation, close fallback) shared with bash.
- Fetch sends a user agent versioned from `package.json` instead of a stale hardcoded one.

## 0.9.0 - 2026-07-10

### Added

- Subagents can handle one or more independent tasks in disposable, isolated contexts. Each worker receives a bounded task description and fresh project instructions for its scope. Mode, profile, and model selection are explicit. Workers return compact results, while their private telemetry stays out of the parent context and saved sessions.
- `/fleet` accepts temporary `--review`, `--profile`, `--workers`, and `--concurrency` options. The runtime now enforces concurrency, deadlines, and tool-call limits. It serializes mutations across retries and quarantines work that ignores an abort instead of relying on scheduling instructions in the prompt.

### Security

- Private haze state uses `0700` directories and `0600` files on POSIX. Bash and process output, raw-output handles, file operations, LSP documents and frames, grep, and JSONL readers apply byte limits while collecting data. Bash timeouts and aborts terminate process trees.
- Grep rejects ignored roots unless they are requested explicitly. Skills and LSP enforce real workspace or root boundaries. MCP discovery and cleanup have deadlines and respond to aborts. Remote plaintext HTTP endpoints cannot receive credentials.

### Fixed

- `readFile` exact line pages now use a bounded, signature-validated sparse byte-offset index. Later pages no longer rescan from the beginning, cached indexes are invalidated when files change, and empty or trailing-newline final lines retain their previous behavior.
- Timed-out or aborted commands now settle even when an escaped descendant retains stdout or stderr. Forced teardown has a short close fallback, destroys owned streams, and shares process-tree signaling with LSP servers; LSP shutdown and protocol failures now terminate the whole server tree and escalate to `SIGKILL` when needed.
- Malformed IPv6-shaped URL hosts now fail closed instead of bypassing literal-address blocking.
- Subagent input now uses one flat, required capsule schema instead of the old union. This prevents local OpenAI-compatible models from sending empty `{}` calls that fail validation. The orchestration tool no longer expects per-tool Haze context that the main AI SDK turn does not provide. It accepts verbose objectives and pre-mapped scopes within fixed limits, while prompts ask for compact handoffs, spell out worker budgets, and discourage repeated broad retries.
- Turn and tool status now agrees across the UI, events, logs, sessions, and headless output. Retries expose one turn lifecycle, and structured `{ok:false}` results still count as failures.
- Session and debug writes are ordered and flushable. Invalid skills are isolated, malformed settings remain visible, removing the active provider or model clears the selection, and stdio MCP setup no longer asks for HTTP headers.

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
