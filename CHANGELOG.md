# Changelog

## Unreleased

- Moved skill management into in-app slash commands: `/skills list`, `/skills info`, `/skills validate`, `/skills remove --yes`, `/skills install --yes`, and `/skills build`.
- Removed top-level skill management shell commands from the Commander CLI.
- Added `Esc` abort support while Haze is thinking; the active AI SDK request receives an `AbortSignal` cancellation and input is re-enabled.
- Documented current test and lint scripts.

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
