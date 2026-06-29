# Haze

A minimal LLM harness for your terminal.

## What's new in 0.7.0

Haze 0.7.0 focuses on headless observability, safer web fetches, more reliable scoped project instructions, and durable sessions that stay small enough to keep.

- **Live print-mode JSON streams.** `haze -p "…" --output stream-json` emits newline-delimited progress events (`turn_start`, message events, tool events, retries, context overflow, `turn_end`) as they happen, then finishes with the same result envelope as `--output json`. Tool event payloads omit raw inputs/outputs so CI logs stay safe and compact.
- **Pinned-connection `fetch` safety.** Public URL fetching now pins each request and redirect hop to the IP address that passed validation, preserving the original `Host`/TLS server name and closing a DNS-rebinding race between URL validation and connection.
- **Scoped instructions refresh during a turn.** When file tools discover nested `CLAUDE.md`/`AGENTS.md`, Haze injects those instructions into the next model step, tracks file signatures, and rereads changed scoped guidance instead of assuming the first version stays valid forever.
- **Smaller durable sessions.** Session JSONL no longer persists every streaming `message_update`, and large tool outputs in persisted events/snapshots are replaced with previews plus size metadata. Resume remains useful while `~/.haze/sessions` avoids runaway growth.
- **Startup context visibility.** The opening system message now lists which context files were sent with the system prompt, making global/project instruction loading easier to verify.

Previous releases:

- **0.6.0** — AI SDK-native ToolLoopAgent core, optional LSP semantic navigation, MCP server support, unified config pickers, cleaner transcripts, `/context`, and startup update checks.
- **0.5.0** — `fetch` tool for public URLs (Markdown/JSON/text, SSRF-protected), removed all provider env vars (config via `/provider`/`/model`/`/settings`), debug-only LLM logs, command-aware output reduction, Markdown rendering in the CLI, scoped nested context files, and auto-clearing completed tasks.
- **0.4.0** — 3-step skill wizard, language-agnostic skill intent extraction, model-managed tasks, leaner command surface, docs site additions.
- **0.3.0** — Docs site redesign, task bar moves above the activity spinner, tasks auto-clear between sessions.
- **0.2.0** — Reliability release: stronger continuation after failed edits and validation, structured bash classification, parsed validation summaries, multi-line chat input with vertical cursor movement.
- **0.1.0** — Bundled ripgrep, subagent delegation, inline diff display.
- **0.0.3** — Durable sessions, context compaction, provider management.
- **0.0.2** — Markdown skills, autocomplete, listFiles pagination.
- **0.0.1** — Initial release.

Haze works with OpenAI-compatible providers, including OpenRouter and local endpoints. Use `/provider` to choose or add one, then `/model` to select a model.

```txt
  _
 | |
 | |__   __ _ _______
 | '_ \ / _` |_  / _ \
 | | | | (_| |/ /  __/
 |_| |_|\__,_/___\___|
```

Haze keeps guardrails light. The LLM can work from the terminal with freedoms close to yours, while trying to stay scoped to the current project. It is aimed at developers who want an expert-oriented tool, not a permission dialog factory. Watch the tool calls. Keep your hands near the wheel. Progress.

## Getting started

Install Haze:

```bash
npm install -g @denizokcu/haze
```

Open Haze from your project:

```bash
$ haze
```

On first run, create or choose a provider, then choose your first model:

```txt
/provider
/model
```

`/provider` opens provider setup for any OpenAI-compatible endpoint — e.g. OpenRouter, OpenAI, LM Studio, Ollama, or a proxy. Haze will ask for a provider name, base URL, optional API key, and model names.

`/model` selects the model Haze should use. You can also set one directly:

```txt
/model anthropic/claude-sonnet-4.6
/model local:llama3.1
```

### MCP servers

Use `/mcp` to connect [Model Context Protocol](https://modelcontextprotocol.io) servers and give the agent extra tools. It opens an interactive picker (like `/provider`): choose a server to enable, disable, remove, or set an API key for it, or choose **add server** to add one from a preset (Context7 ships built-in for up-to-date library docs) or enter custom details.

```txt
/mcp            # opens the server picker
# add server -> context7                       (preset)
# add server -> custom -> name -> http -> url  (custom remote)
# add server -> custom -> name -> stdio -> cmd (custom local)
```

API keys are entered in a masked prompt and sent as `Authorization: Bearer <value>`. Servers persist in `~/.haze/settings.json` under `mcpServers` and support `http`, `sse`, and `stdio` transports. Their tools load at the start of each agent turn and the connections close when the turn ends. An unreachable server is isolated and never blocks the agent, and MCP tools never shadow built-in tools.

Saved settings live in `~/.haze/settings.json`. Providers can include API keys, base URLs, and model lists; local OpenAI-compatible providers can be configured without a key. Use `/provider`, `/model`, and `/settings` to configure everything from inside Haze — there are no environment variables to set.

Haze is intentionally minimal: chat, local tools, context files, sessions, and Markdown skills. Any workflow beyond the core is meant to be grown with the LLM through `/skills` (an interactive picker: generate a custom skill from a description, then enable/disable, validate, or remove it). If you want reviews, release prep, deploy checks, debugging rituals, or your team's strange checklist, ask Haze to create a skill and then refine the Markdown.

## Get productive immediately

Open a project and ask for work:

```txt
create a calculator in calc-app in ruby with add subtract multiply divide
```

Haze will inspect, search, write files, fetch public URLs, run commands, and show compact tool activity inline. Small file edits include a colorized line diff with one context line before and after the change; large diffs stay summarized so the transcript does not become a wall of noise. Bash output is reduced by command-aware filters for validation, git, search, JSON, diffs, and noisy logs; failures point at the relevant files, tests, or diagnostics, and raw output remains available by handle when it was omitted. Sessions are saved by default so you can resume the latest workspace conversation with `haze --continue` or `/resume`.

Use `/` to discover commands and skills. `Tab` completes the top suggestion.

Useful starters:

```txt
/init
/skills        # then add skill: name + a description like:
                # "review my current branch against main like a senior engineer"
                # "prepare clean git commits from my uncommitted changes"
                # "implement small features with tests and a concise summary"
```

`/init` creates or updates `AGENTS.md` so future sessions understand the project.

## Skills: your workflows, grown while working

Skills are Markdown workflows that Haze creates with `/skills` and stores in `~/.haze/skills` so you can inspect or refine them later.

If you do something for the second time, build a skill for it:

```txt
/skills
# Picker → add skill
# Name: branch-diff-review
# Description: review the diff between my current branch and main, focusing on bugs, tests, DRY and KISS
```

Haze uses the model to create the skill file for you:

```txt
~/.haze/skills/<skill-name>/SKILL.md
```

A skill is just Markdown with frontmatter, a role, a focused prompt, and a small output template:

```md
---
name: code-review-diff-main
description: Use when the user asks for a code review of the current branch against main.
---

# Role

You are a focused code reviewer.

# Focused prompt

Review the actual change and return useful, evidence-based feedback.

# Procedure

Inspect branch state, changed files, staged and unstaged diffs, then review incrementally.

# Output template

## Summary
- <scope and result>

## Findings
- <prioritized findings, or "No issues found">

## Evidence inspected
- <commands/files used>
```

Installed skills appear as slash commands like:

```txt
/code-review-diff-main
```

They are also available through one `skill` catalog tool. Haze loads one workflow body first and fetches large references only when needed. Skills provide instructions; they do not execute code.

This is the trick: do normal work, notice friction, create a skill, keep going. Your workflow adapts instead of asking you to adapt to the tool. Rude, but in a good way.

## Commands

```txt
/help
/provider
/model
/model <name-or-provider:name>
/model list
/settings
/settings open
/logs [id]
/lsp
/mcp
/init
/context
/session
/resume
/new
/compact [instructions]
/clear
/exit

/skills
```

Skill management is a single interactive picker, mirroring `/provider`, `/lsp`, and `/mcp`: generate a custom skill from a description, then show info, enable/disable, validate, or remove. Disabled skills drop out of the model catalog and the `/<name>` command list until re-enabled.

CLI flags:

```bash
haze --debug       # show model/tool debug logs and write detailed JSONL logs to ~/.haze/logs
haze --continue    # resume the latest saved session for this workspace
haze --no-session  # run without durable session storage
```

Non-interactive / print mode:

```bash
haze -p "refactor utils.ts to remove the unused export"
haze -p "summarize this repo" --model openai:gpt-4o-mini
haze -p "list the top 3 bugs in src/api.ts" --output json
haze -p "audit src/auth.ts" --output stream-json   # live NDJSON events, then the result envelope
echo "what does this project do?" | haze
```

`-p` / `--prompt` runs a single agentic turn (with the full tool set and guardrails) and prints the final assistant text. `--model` overrides the active model for that one run without changing `~/.haze/settings.json` — accepts a bare model name or `provider:name`. The selected model must already be registered under a provider's `models` (add it once via `/provider`); an unknown or ambiguous selector exits non-zero with a precise error on stderr. When `-p` is omitted and stdin is piped, the prompt is read from stdin. A one-shot run never starts or resumes a durable session; `--continue` is ignored in this mode. Headless runs do **not** auto-compact on context overflow, so very large CI prompts may fail rather than recover — keep prompts within the model's window. Add `--debug` to also write a detailed JSONL log under `~/.haze/logs/`. `--output` selects how the run is reported: `text` (default), `json` (a single final envelope), or `stream-json` (a live NDJSON event stream ending in that envelope) — see below.

`--output json` prints a single-line envelope instead of plain text:

```json
{
  "type": "result",
  "status": "complete",            // "complete" (exit 0) | "aborted" | "failed" (both exit non-zero)
  "result": "the final assistant text",
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0
  }
}
```

The `status` field is authoritative (driven by the agent's terminal state, not by parsing `result`), and the exit code mirrors it: `0` only for `complete`. A `complete` run with an empty `result` means the model produced no visible text — distinct from a `failed` run.

`--output stream-json` streams the run as it happens instead of staying silent until the end. Each public progress event is written to stdout as one newline-delimited JSON object (NDJSON), and the **last** line is the exact same `{ type: "result", status, result, usage }` envelope as `--output json` — so a consumer can render live progress and still parse the final line identically:

```jsonc
{"type":"turn_start","request":"audit src/auth.ts","at":"2026-06-27T22:00:00.000Z"}
{"type":"message_start","id":"a1","role":"assistant","at":"..."}
{"type":"message_update","id":"a1","text":"Reading the auth module…","at":"..."}
{"type":"tool_start","id":"t1","name":"readFile","at":"..."}
{"type":"tool_end","id":"t1","name":"readFile","success":true,"durationMs":12,"at":"..."}
{"type":"message_end","id":"a1","text":"Here are the findings…","at":"..."}
{"type":"turn_end","request":"audit src/auth.ts","status":"complete","at":"..."}
{"type":"result","status":"complete","result":"Here are the findings…","usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0}}
```

Every line is standalone valid JSON, so the stream pipes cleanly through `jq -c .`. The event types are `turn_start`, `message_start` / `message_update` / `message_end`, `tool_start` / `tool_end`, `retry`, `context_overflow`, and `turn_end`; each carries an ISO-8601 `at` timestamp. Tool events intentionally omit raw tool inputs and outputs because stdout is often captured by CI/harness logs; use `--debug` when detailed local JSONL logs are needed. This mode is intended for harnesses driving Haze autonomously: the incremental, ever-changing output lets a supervisor show live progress and run stdout-based stagnation/loop detection, while the trailing `result` envelope remains the single source of truth for status, text, and usage. `text` and `json` outputs are unchanged.

By default, Haze does **not** write the detailed LLM log files under `~/.haze/logs/` (they capture full prompts, messages, and tool I/O). File logging is only enabled with `haze --debug`, which also turns on the on-screen debug panel. Use the `/logs` command to review past log files once logging has been enabled.

## Agent tools

Haze exposes a deliberately small toolset:

- `listFiles` — structured discovery, recursive with cursor pagination when needed.
- `readFile` — read numbered UTF-8 lines in bounded pages, with `nextOffset` when more remain.
- `grep` — structured ripgrep search with a true global result cap and compacted long lines/results.
- `editFile` — unique text replacements, with line-number-prefix tolerance for common model mistakes.
- `replaceLines` — line-range edits when exact replacements are awkward; slightly-too-large EOF ranges are clamped.
- `writeFile` — create files and parent directories.
- `bash` — run tests, builds, git/gh commands, inspections, scripts, installs, and other shell workflows with command-aware output reduction (git, gh, search, JSON, diffs, logs) and compact validation output.
- `readToolOutput` — page through full/raw output omitted from an oversized or reduced tool result.
- `fetch` — read a public `http(s)` URL and return readable content (Markdown for docs, pretty JSON, or text). Private/loopback/metadata hosts and non-`http(s)` schemes are blocked; output is bounded and retrievable via `readToolOutput`.
- `writeTasks` — replace the task list at meaningful phase changes; completed lists auto-clear on the next user turn.
- `skill` — load one installed Markdown workflow or one of its references.
- `lspWorkspaceSymbols`, `lspSymbols`, `lspDefinition`, `lspReferences` — optional read-only semantic navigation through user-configured language servers. These tools are exposed only when an enabled LSP command is installed.

Tool calls are grouped in the transcript so you can see what happened without reading a novella. Successful targeted file edits show a compact diff with colored additions/removals and one context line around the change when the diff is small; larger diffs are summarized with a pointer to `git diff`. File-tool failures return structured reason codes and recovery hints. Large bash/search/fetch output is kept behind an in-memory handle so later model calls carry only reduced validation, git, search, diff, JSON, log, or head/tail summaries.

### Optional LSP navigation

Haze can use user-configured stdio Language Server Protocol servers for semantic code navigation. Configure them with `/lsp` (an interactive picker, like `/provider` and `/mcp`): add a preset or a custom command, then enable/disable/remove servers. Presets currently include TypeScript, Rust, Python, Go, and PHP. Haze does not install language servers for you, and it hides LSP tools from the model unless an enabled server command exists on `PATH`, so projects without LSP still use `grep`, `listFiles`, and `readFile` normally.

Example TypeScript setup:

```bash
npm install -g typescript typescript-language-server
```

```txt
/lsp
# -> add server -> typescript
```

## Subagents

Subagents are a delegation feature, not another file operation. When a request clearly splits into independent parallel work, Haze can spin up focused agents with fresh context, let them inspect or act with their own capped tool loop, then fold their concise summaries back into the main conversation.

Use them for parallel investigation across separate areas of a codebase. Do not use them for single sequential tasks where the main agent already has the best context.

## Context files

Haze saves durable workspace sessions in `~/.haze/sessions`. Use `/session` to see the current file, `/new` to start fresh, `/resume` to restore the latest session, and `/compact` to summarize older model context. Sessions also persist compact structured work state: the active goal, touched files, validation evidence, blockers, and next action.

Session files are optimized for resume and audit, not token-by-token playback: completed user/assistant messages, tool lifecycle events, conversation snapshots, and work-state snapshots are persisted, but streaming `message_update` events are skipped. Large persisted tool outputs are replaced with previews and byte counts so a resumed model can reread current files instead of carrying stale megabytes forward.

Long turns use bounded tool slices. Older successful tool results are compacted while failures and recent evidence remain verbatim, synthetic Haze control nudges are not persisted as user requests, and token-pressure compaction preserves the structured work state.

Haze loads project instructions from:

- `~/.claude/CLAUDE.md`
- `~/.haze/AGENTS.md`
- `CLAUDE.md` / `AGENTS.md` files from filesystem root to the current workspace

At the same scope, `AGENTS.md` overrides `CLAUDE.md`; global Haze guidance in `~/.haze/AGENTS.md` overrides global Claude guidance in `~/.claude/CLAUDE.md`. Nested `CLAUDE.md` / `AGENTS.md` files below the workspace are scoped: Haze surfaces them only when file tools operate inside that directory or its subdirectories, injects newly discovered scoped guidance into the next model step, and mutating tools stop once so the model can review it before editing. Scoped context files are tracked by signature, so changed nested guidance can be read again later in the same session.

Use `AGENTS.md` for project conventions, commands, architecture notes, and things future-you does not want to re-explain. `/init` is intentionally budget-aware: it does one small discovery pass, preserves useful existing guidance, and asks for a compact file because context files are injected into every request.

## Safety model

- File tools are restricted to the current workspace.
- File tools follow `.gitignore` by default.
- Ignored files require an explicit override.
- Bash commands are classified and shown with working-directory metadata, but Haze does not use command confirmation gates.
- The `fetch` tool reads public `http(s)` URLs only; private, loopback, link-local, and cloud-metadata hosts and non-`http(s)` schemes are blocked, and each redirect hop is connected to the already validated public IP to avoid DNS-rebinding races.
- Mutating and destructive commands can run when they are relevant to the user's request; this is intentional for expert users.
- Haze is powerful enough to help and dumb enough to deserve supervision. Ideal software, basically.

## Local development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
npm run context:report
```

`npm run context:report` prints estimated system, project-context, and tool-schema tokens without reading `~/.haze`. Pass explicit context-file paths, or use `npm run context:report -- --trace tests/fixtures/agent-traces/long-workflow.json` for offline trace accounting.

Package check:

```bash
npm pack --dry-run
```

The npm package ships `bin`, `dist`, README, license, changelog, and examples.

## Release

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
git tag vX.Y.Z
git push origin main --tags
npm publish --access public
```

## License

MIT
