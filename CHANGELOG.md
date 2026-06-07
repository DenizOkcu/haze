# Changelog

## Unreleased

## 0.2.0 - 2026-06-07

- Improved coding-loop reliability with stronger continuation behavior after failed edits, failed validation, missing validation, tool-budget interruptions, and incomplete assistant responses.
- Added structured bash command classification for read-only, mutating, destructive, network, validation, and unknown commands, with cwd, duration, timeout, and classification metadata in bash results.
- Added validation-output parsing for common test, typecheck, lint, and build commands, including failed files, failed tests, diagnostics, summaries, and suggested next steps.
- Added shared structured tool result types and more specific file-edit failure reason codes so edit recovery can reread the affected file and retry with better guidance.
- Reworked the system prompt, subagent prompt, compaction prompt, and generated-skill guidance around autonomous expert developer workflows with concise final status reporting.
- Removed hard-coded `temperature: 0` from model calls so providers/models that reject temperature options can run without warning workarounds.
- Removed bash confirmation gates, including for destructive classifications; Haze now assumes expert users know what they asked for and relies on transparent tool output rather than permission prompts.
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
