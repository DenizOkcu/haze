# Changelog

## Unreleased

## 0.8.0 - 2026-07-09

### Changed

- **Migrated the agent runtime to AI SDK v7.** The main `ToolLoopAgent` turn and subagent runner now use AI SDK v7 APIs while preserving haze's compact terminal rendering, turn-scoped tool state, loop guardrails, and scoped-context injection behavior.
- **Improved live busy feedback.** The interactive busy line now shows the active model name, a one-second elapsed-time heartbeat, and current tool activity labels such as reading, editing, searching, running commands, loading skills, querying LSP, or running MCP tools. Long model/tool gaps now visibly progress instead of looking frozen.
- **Bounded bash output processing.** Bash reducer paths now bound large output processing more aggressively before output enters the transcript/model context, keeping validation/search/log-heavy commands safer for long-running agent work.
- **Hardened core agent maintenance paths.** Tool context wiring, maintenance prompts, and related agent guidance were tightened for AI SDK v7 and current haze runtime behavior.
- **Standardized lowercase `haze` naming.** README, docs, prompts, skills, command help, tests, and agent guidance now consistently use lowercase `haze` for the product name.

### Fixed

- Fixed multiline input shortcut handling in the chat input.
- Kept model thinking labels concise without hiding useful slash-model suffixes such as reasoning variants.
- Compacted long file paths in live tool labels so the busy line stays readable.

## 0.7.0 - 2026-06-29

### Added

- **`--output stream-json` for print mode.** `haze -p "…" --output stream-json` streams the run as newline-delimited JSON: public progress events (`turn_start`, `message_start`/`message_update`/`message_end`, `tool_start`/`tool_end`, `retry`, `context_overflow`, `turn_end`, each with an ISO-8601 `at` timestamp) are written to stdout as they happen, and the final line is the same `{type,status,result,usage}` envelope as `--output json`. Tool events omit raw inputs/outputs so captured stdout stays suitable for harness and CI logs. Previously print mode stayed silent until the end and emitted only that single envelope, so harnesses driving haze headlessly had no live progress and could not run stdout-based stagnation/loop detection on a silent-but-alive run. Every line is standalone valid JSON (pipeable through `jq -c .`). `text` and `json` outputs are unchanged.
- **Startup context visibility.** The interactive startup message now lists the context files sent with the system prompt, making it easier to verify whether global `CLAUDE.md`/`AGENTS.md` and workspace instructions were loaded.

### Changed

- **CLI print mode.** `haze -p "prompt"` runs a single non-interactive turn and prints the result, with optional `--model provider:name` override (per-run, no settings write) and `--output json` structured output. Reads the prompt from stdin when piped. The exit code and JSON `status` are driven by the agent's authoritative terminal state (`complete`/`aborted`/`failed`) rather than by parsing the reply, so CI gating on the exit code is reliable. A bad or ambiguous `--model` selector reports a precise error and exits non-zero, `--debug` writes a JSONL log under `~/.haze/logs/`, and the `--output json` `usage` object is pinned to a documented set of fields.
- **Scoped context refresh during turns.** Nested `CLAUDE.md`/`AGENTS.md` files discovered by file tools are injected into the next model step, tracked by signature, and reread when they change. Concurrent scoped-context discovery is serialized so unchanged instruction files are read once while still surfacing newly changed guidance.
- **Smaller durable session files.** Session persistence now drops streaming `message_update` events and slims large tool outputs/errors in persisted `tool_end` events and `conversation_snapshot` tool results to previews plus byte counts. Sessions remain resumable while avoiding runaway JSONL growth from repeated streamed text or large file reads.

### Security

- **Closed a DNS-rebinding TOCTOU in the `fetch` tool.** `urlGuard.validateUrl` resolved a hostname and confirmed every address was public, but the subsequent global `fetch` re-resolved the hostname at connect time, so an attacker-controlled DNS server could answer validation with a public IP and connect with an internal/cloud-metadata IP — fully bypassing the SSRF guard that exists precisely to stop that. `fetchUrlContent` now pins each connection (and each redirect hop) to the already-validated IP via a small stdlib transport that preserves the original `Host` header and TLS `servername`/cert verification, with no second DNS lookup between validation and connect. The post-fetch re-validation was removed as it re-resolved DNS against an already-pinned connection and only reopened the race. Literal-IP URLs keep using the global `fetch` (no rebinding surface).

## 0.6.0 - 2026-06-21

### Added

- **MCP server support.** haze can now connect to [Model Context Protocol](https://modelcontextprotocol.io) servers and expose their tools to the agent alongside the built-in toolset. `/mcp` opens an interactive picker (like `/provider`) to add a server from a preset (Context7 ships built-in for up-to-date library docs) or custom `http`/`sse`/`stdio` details, then enable/disable/remove it or set a masked API key. Servers persist in `~/.haze/settings.json` under `mcpServers`. MCP clients open per agent turn and close when it ends; a failing server is isolated and MCP tools never shadow built-ins.
- Added optional configurable stdio LSP support through `/lsp`, with TypeScript, Rust, Python, Go, and PHP presets.
- Added read-only semantic navigation tools (`lspWorkspaceSymbols`, `lspSymbols`, `lspDefinition`, `lspReferences`) that are exposed to the model only when an enabled LSP command is installed on `PATH`.
- Added `/context`, a token breakdown of the current request (system prompt, project context, tools including MCP, and chat messages).
- Added `/settings open` to open `~/.haze/settings.json` with the OS default app.
- Added a non-blocking startup update check (throttled to once per 24 h via `~/.haze/updateCheck.json`) that surfaces a newer published version when one exists; every failure mode resolves silently.

### Changed

- Switched the main agent turn to the AI SDK v6 `ToolLoopAgent` abstraction while preserving compact terminal tool/text rendering and key loop guardrails.
- Improved transcript segmentation so assistant text and tool blocks alternate cleanly during multi-step turns.
- Added LSP-aware prompt guidance only when LSP tools are actually available; otherwise haze naturally falls back to `grep`, `listFiles`, and `readFile`.
- Made `/lsp` and `/mcp` interactive pickers matching the `/provider` flow (autocomplete lists, preset pickers, masked API-key entry), replacing the previous `/lsp`/`/mcp` subcommand syntax.
- Unified skill management into a single `/skills` interactive picker that mirrors `/provider`, `/lsp`, and `/mcp`; removed the legacy `/create-skill`, `/skill-info`, `/validate-skill`, and `/remove-skill` commands.
- Updated README, docs site, and project agent guidance for LSP setup and the 0.6.0 release.

## 0.5.0 - 2026-06-19

### Changed

- Removed all user-facing environment variables. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `HAZE_MODEL`, and `HAZE_CONTEXT_BUDGET_SHARE` are no longer read; configure providers, models, API keys, and base URLs through `~/.haze/settings.json` and the `/provider`, `/model`, `/settings` slash commands instead. This also removes the `OPENAI_*` env overrides from the startup provider info and the header.
- File LLM logging is now **off by default**. Previously haze wrote a detailed JSONL log (full prompts, model messages, tool inputs/outputs, token usage) to `~/.haze/logs/<timestamp>.jsonl` on every session. Logging is now enabled solely with the `--debug` flag (`haze --debug`), which also turns on the on-screen debug panel. The `/logs` command still reviews historical log files.
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

- Replaced single-shot `/create-skill <description>` with a 3-step interactive wizard: name → optional role → description. The user-supplied name and role are used verbatim — the model no longer renames them.
- Added language-agnostic intent extraction. Skill descriptions are interpreted by the model in any language, replacing the previous English-only regex strip. `"crée une compétence qui vérifie le style du code"` now produces a skill that vérifies code style, not a skill about creating something.
- Added `toSkillDirName` for kebab-casing user-typed skill names without stop-word stripping (so `"create a skill"` stays `create-a-skill`, not `skill`).

### Commands

- Removed the `/tasks` slash command. Tasks are now managed exclusively by the model via the `writeTasks` tool — `/clear` still wipes them as a side effect of clearing the conversation.
- Removed the `/list-skills` alias; `/skills` now shows the overview and the installed list.
- Removed the `/skill <subcommand>` and `/skills <subcommand>` legacy routing forms. Each skill operation now has exactly one user-facing form: `/skills`, `/create-skill`, `/skill-info`, `/validate-skill`, `/remove-skill`.
- Removed the `/tasks rm` alias for `/tasks remove`.
- Refactored `handleSkillCommand` from stringly-typed `value` parsing to a typed `SkillSubcommand` union argument.

### Docs site

- Added §02 "Native skill creation" segment that frames the 3-step wizard as the haze superpower, with a live transcript of the wizard prompts, superpower bullets, and copy-pasteable recipe cards for `/code-review`, `/deploy-check`, `/release-prep`, `/security-review`.
- Added §07 "Commands index" — a categorized reference of all 16 slash commands plus the `/<skill-name>` dynamic invocations.
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
