# haze

A minimal LLM harness for your terminal.

## What's new in 0.9.0

haze 0.9.0 addresses the security and correctness issues found during the 0.8.0 code review.

- Settings, sessions, logs, and history now use `0700` directories and `0600` files on POSIX. haze also tightens permissions on older files and directories when it can.
- Turn and tool status now agrees across the UI, events, logs, sessions, and headless exit codes. A turn reports `failed` if it ends without a substantive answer, leaves a tool failure unresolved, or reaches a hard step or tool budget, even if the provider returned normally.
- File reads, bash and grep output, LSP traffic, and stored handles are byte-bounded as data arrives. `readFile` keeps a small sparse index of line offsets for paging. When bash times out or is aborted, haze kills the process tree and returns even if an escaped child still has an output pipe open.
- `grep` rejects directly named ignored files. Skills and LSP stay within real workspace or root paths, including through symlinks. MCP discovery has deadlines and responds to aborts. Credentials cannot be sent over remote plaintext HTTP, though loopback HTTP still works.
- Sessions and debug logs preserve write order, flush at the end of a turn and during shutdown, and report persistence failures.

Previous releases:

- `0.8.0`: AI SDK v7 runtime, live status with model, elapsed time, and tool labels; bounded bash output processing; lowercase `haze` naming.
- `0.7.0`: headless `-p`, `--output json`, and `--output stream-json`; pinned-connection `fetch` safety; scoped instruction refresh; smaller sessions; startup context visibility.
- `0.6.0`: AI SDK-native ToolLoopAgent core, optional LSP navigation, MCP support, unified configuration pickers, cleaner transcripts, `/context`, and startup update checks.
- `0.5.0`: SSRF-protected public URL fetching, no provider environment variables, debug-only LLM logs, command-aware output reduction, CLI Markdown rendering, scoped nested context files, and automatic cleanup of completed tasks.
- `0.4.0`: three-step skill wizard, language-agnostic skill intent extraction, model-managed tasks, a smaller command surface, and docs site additions.
- `0.3.0`: redesigned docs site, a relocated task bar, and automatic task cleanup between sessions.
- `0.2.0`: more reliable recovery from failed edits and validation, structured bash classification, parsed validation summaries, and multiline input with vertical cursor movement.
- `0.1.0`: bundled ripgrep, subagent delegation, and inline diffs.
- `0.0.3`: durable sessions, context compaction, and provider management.
- `0.0.2`: Markdown skills, autocomplete, and `listFiles` pagination.
- `0.0.1`: initial release.

haze works with OpenAI-compatible providers, including OpenRouter and local endpoints. Use `/provider` to choose or add one, then `/model` to select a model.

```txt
  _
 | |
 | |__   __ _ _______
 | '_ \ / _` |_  / _ \
 | | | | (_| |/ /  __/
 |_| |_|\__,_/___\___|
```

haze keeps guardrails light. The LLM can work from the terminal with access close to yours while staying scoped to the current project where possible. It is for developers who would rather supervise tool calls than work through a stack of permission dialogs. Keep an eye on what it does.

## Getting started

Install haze:

```bash
npm install -g @denizokcu/haze
```

Open haze from your project:

```bash
$ haze
```

On first run, create or choose a provider, then choose your first model:

```txt
/provider
/model
```

`/provider` sets up any OpenAI-compatible endpoint, such as OpenRouter, OpenAI, LM Studio, Ollama, or a proxy. haze asks for a provider name, base URL, optional API key, and model names.

`/model` selects the model haze should use. You can also set one directly:

```txt
/model anthropic/claude-sonnet-4.6
/model local:llama3.1
```

### MCP servers

Use `/mcp` to connect [Model Context Protocol](https://modelcontextprotocol.io) servers and give the agent more tools. The interactive picker works like `/provider`: enable, disable, or remove a server; set its API key; or add one from a preset or custom configuration. The built-in Context7 preset provides current library documentation.

```txt
/mcp            # opens the server picker
# add server -> context7                       (preset)
# add server -> custom -> name -> http -> url  (custom remote)
# add server -> custom -> name -> stdio -> cmd (custom local)
```

API keys for HTTP/SSE servers are entered in a masked prompt and sent as `Authorization: Bearer <value>`. Stdio authentication belongs in the command or wrapper; haze does not attach HTTP headers to stdio. Servers persist in `~/.haze/settings.json` under `mcpServers`. Discovery and cleanup have bounded deadlines, failures are isolated, and MCP tools never shadow built-ins.

Saved settings live in `~/.haze/settings.json`. Provider keys and MCP headers require HTTPS unless the endpoint uses loopback HTTP (`localhost`, `*.localhost`, `127/8`, or `::1`). Keyless HTTP remains available, and local OpenAI-compatible providers do not need a key. If the settings file is malformed, haze shows an actionable startup error instead of treating it as empty. Configure everything inside haze with `/provider`, `/model`, and `/settings`; there are no environment variables to set.

haze focuses on chat, local tools, context files, sessions, and Markdown skills. Use `/skills` for workflows outside that core. Its interactive picker can generate a skill from a description, then enable, disable, validate, or remove it. For reviews, release prep, deploy checks, debugging routines, or a team-specific checklist, ask haze to create a skill and edit the resulting Markdown as needed.

## Start using haze

Open a project and ask for work:

```txt
create a calculator in calc-app in ruby with add subtract multiply divide
```

haze can inspect and edit files, fetch public URLs, and run commands. Tool activity stays compact in the transcript. Small edits show a colorized diff with one line of context on either side; large diffs get a short summary instead. Bash output is capped while the command runs, then filtered according to the command type. Validation failures keep the useful diagnostics. Raw output handles have per-entry and total memory limits, and tell you how many bytes were dropped. Sessions are saved by default, so you can pick up the latest workspace conversation with `haze --continue` or `/resume`.

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

## Skills that grow with your workflow

Skills are Markdown workflows that haze creates with `/skills` and stores in `~/.haze/skills` so you can inspect or refine them later.

If you do something for the second time, build a skill for it:

```txt
/skills
# Picker → add skill
# Name: branch-diff-review
# Description: review the diff between my current branch and main, focusing on bugs, tests, DRY and KISS
```

haze uses the model to create the skill file for you:

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

They are also available through one `skill` catalog tool. haze loads one workflow body first and fetches large references only when needed. Skills provide instructions; they do not execute code.

When you catch yourself repeating the same instructions, put them in a skill. The workflow stays in a Markdown file that you can read and edit.

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

`-p` and `--prompt` run one agentic turn with the full tool set and print the final assistant text. `--model` accepts a bare model name or `provider:name` and overrides the active model for that run without changing `~/.haze/settings.json`. The model must already be registered under a provider's `models`; add it once with `/provider`. Unknown or ambiguous selectors print a specific error to stderr and exit nonzero.

If you pipe stdin without `-p`, haze reads the prompt from stdin. One-shot runs do not start or resume durable sessions, and they ignore `--continue`. They also do not compact automatically after a context overflow, so keep large CI prompts within the model's context window. Add `--debug` to write a detailed JSONL log under `~/.haze/logs/`.

`--output` controls the result format: `text` is the default, `json` prints one final envelope, and `stream-json` writes live NDJSON events followed by the same envelope.

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

The `status` field is authoritative (driven by the agent's terminal state, not by parsing `result`), and the exit code mirrors it: `0` only for `complete`. A turn that ends without a substantive final answer, after an unresolved final tool failure, or at a hard step/tool budget is `failed` even if the provider returned normally.

`--output stream-json` writes progress as the run happens. Each public event is one newline-delimited JSON object on stdout. The last line uses the same `{ type: "result", status, result, usage }` envelope as `--output json`, so consumers can display progress and parse the final result in the same way:

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

Each line is valid JSON and can be piped through `jq -c .`. Event types include `turn_start`, `message_start` / `message_update` / `message_end`, `tool_start` / `tool_end`, `retry`, `context_overflow`, and `turn_end`. Every event has an ISO-8601 `at` timestamp. Tool events omit raw inputs and outputs because CI and harness logs often capture stdout; use `--debug` for detailed local JSONL logs.

This mode is intended for harnesses that run haze without a person at the terminal. A supervisor can watch stdout for progress, stalls, or loops. The final `result` envelope contains the authoritative status, text, and usage. The `text` and `json` formats are unchanged.

By default, haze does not write detailed LLM logs under `~/.haze/logs/`; those files contain full prompts, messages, and tool I/O. Run `haze --debug` to enable file logging and the on-screen debug panel. Use `/logs` to review saved logs.

## Agent tools

haze has a small built-in toolset:

- `listFiles` handles structured discovery and recursive listings, with cursor pagination when needed.
- `readFile` returns numbered UTF-8 lines in bounded pages, with `nextOffset` when more remain. It keeps a small, signature-checked index of line offsets so later pages do not start from the top of the file. File contents are not cached.
- `grep` runs structured ripgrep searches with a global result cap and compacts long lines and result sets. It rejects directly named ignored roots unless `includeIgnored` is set.
- `editFile` makes unique text replacements and tolerates accidental line-number prefixes.
- `replaceLines` edits line ranges when exact replacements are awkward and clamps ranges that extend slightly past EOF.
- `writeFile` creates files and parent directories.
- `bash` runs tests, builds, git and gh commands, scripts, installs, and other shell work. It trims output according to the command type while keeping useful failure details. A timeout or abort kills the process tree, escalates if necessary, and returns even when an escaped child keeps stdout or stderr open.
- `readToolOutput` pages through retained raw output omitted from oversized or reduced results, subject to in-memory budgets.
- `fetch` reads public `http(s)` URLs as Markdown, formatted JSON, or text. It rejects non-HTTP schemes, private and loopback addresses, metadata hosts, and malformed IPv6-like hosts. Bounded output remains available through `readToolOutput`.
- `writeTasks` replaces the task list at meaningful phase changes. Completed lists clear on the next user turn.
- `skill` loads an installed Markdown workflow or one of its references.
- `lspWorkspaceSymbols`, `lspSymbols`, `lspDefinition`, and `lspReferences` provide optional read-only navigation through configured language servers. They appear only when an enabled server command is installed.

Tool calls are grouped in the transcript so you can see what happened without reading a novella. A small file edit shows colored additions and removals with one line of context. A large one gets a summary and a pointer to `git diff`. File-tool failures include a reason code and a recovery hint. Large bash, search, and fetch results stay behind an in-memory handle. Later model calls see a compact summary tailored to validation, git, search, diffs, JSON, logs, or the head and tail of the output.

### Optional LSP navigation

haze can use stdio Language Server Protocol servers for semantic code navigation. Open `/lsp` to add a preset or custom command, then enable, disable, or remove it. The presets cover TypeScript, Rust, Python, Go, and PHP. You install the server yourself. haze only exposes LSP tools when an enabled server command is on `PATH`; otherwise it uses `grep`, `listFiles`, and `readFile`. When haze closes a server or rejects malformed protocol output, it terminates the server's process tree and forces it to exit if necessary.

Example TypeScript setup:

```bash
npm install -g typescript typescript-language-server
```

```txt
/lsp
# -> add server -> typescript
```

## Subagents

A subagent is a disposable worker with its own context. It is useful for a repository survey, log diagnosis, documentation search, or noisy validation run that would swamp the main conversation. The point is to isolate context, not merely to run things in parallel.

The worker receives a bounded description of its objective, deliverable, mode, and scope. It does not see the main conversation or sibling conversations, and it loads the relevant `AGENTS.md` or `CLAUDE.md` files itself. Only its compact result returns to the parent model. Tool logs, timings, usage, and estimated context savings stay out of that context.

The available modes are `inspect` (read-only), `research` (read-only with public fetch), `implement` (file changes and coordinated bash), and `validate` (reads and coordinated bash). Read-only modes cannot change files. Workers that can make changes are serialized with each other and with changes from the main turn. This coordination is not a shell sandbox.

Tool-call budgets apply to each execution, including calls submitted together. At the deadline, haze returns a terminal result and aborts the worker. If the underlying code ignores the abort, haze quarantines it and keeps its actual concurrency and mutation slot occupied until it settles. Retries stay within the same turn scope. Result handles exist only in the current process and are not durable, so each compact deliverable must stand on its own.

`/fleet` remains parallel-only model decomposition over the same worker primitive. Its control guidance is ephemeral and sessions retain only the original invocation, task/result capsules, and final answer. Supported one-run flags are:

```text
/fleet --review <prompt>
/fleet --profile local-safe <prompt>
/fleet --workers provider:model <prompt>
/fleet --concurrency 2 <prompt>
/fleet -- --prompt-that-starts-with-a-flag
```

Built-in profiles are `local-safe`, `local-throughput`, `cloud-balanced`, and `cloud-fast`. haze never infers a profile from a provider name or endpoint URL. If no profile is selected, it uses a provider-neutral compatibility baseline. If no worker model is set, it reuses the explicitly selected active model. An invalid worker model or profile blocks execution instead of falling back. Settings can select or customize profiles:

```json
{
  "subagents": {
    "workerModel": "local:qwen3-coder",
    "defaultProfile": "local-safe",
    "profiles": {"local-safe": {"maxConcurrency": 1, "deadlineMs": 300000}}
  }
}
```

Keep trivial, conversation-coupled, sequential, user-interactive, or uncertain shared-mutation work in the main thread.

## Context files

haze saves durable workspace sessions in `~/.haze/sessions`. Settings, history, sessions, and debug logs use private POSIX directory/file permissions (`0700`/`0600`) and ordered, flushable writes. Use `/session` to see the current file, `/new` to start fresh, `/resume` to restore the latest session, and `/compact` to summarize older model context. Sessions also persist compact structured work state: the active goal, touched files, validation evidence, blockers, and next action.

Session files are optimized for resume and audit, not token-by-token playback: completed user/assistant messages, tool lifecycle events, conversation snapshots, and work-state snapshots are persisted, but streaming `message_update` events are skipped. Large persisted tool outputs are replaced with previews and byte counts so a resumed model can reread current files instead of carrying stale megabytes forward.

Long turns use bounded tool slices. Older successful tool results are compacted while failures and recent evidence remain verbatim, synthetic haze control nudges are not persisted as user requests, and token-pressure compaction preserves the structured work state.

haze loads project instructions from:

- `~/.claude/CLAUDE.md`
- `~/.haze/AGENTS.md`
- `CLAUDE.md` / `AGENTS.md` files from filesystem root to the current workspace

At the same scope, `AGENTS.md` overrides `CLAUDE.md`; global haze guidance in `~/.haze/AGENTS.md` overrides global Claude guidance in `~/.claude/CLAUDE.md`. Nested `CLAUDE.md` / `AGENTS.md` files below the workspace are scoped: haze surfaces them only when file tools operate inside that directory or its subdirectories, injects newly discovered scoped guidance into the next model step, and mutating tools stop once so the model can review it before editing. Scoped context files are tracked by signature, so changed nested guidance can be read again later in the same session.

Use `AGENTS.md` for project conventions, commands, architecture notes, and anything you do not want to explain again. Because context files are added to every request, `/init` keeps its discovery pass small, preserves useful existing guidance, and asks for a compact file.

## Safety model

- File tools are restricted to the current workspace.
- File tools follow `.gitignore` by default.
- Ignored files require an explicit override.
- Bash commands are classified and shown with working-directory metadata, but haze does not use command confirmation gates.
- The `fetch` tool only reads public `http(s)` URLs. It rejects other schemes along with private, loopback, link-local, cloud-metadata, and malformed IPv6-like hosts. On every redirect, haze connects to the public IP it already validated, which closes the DNS-rebinding gap.
- Mutating and destructive commands can run when they are relevant to the user's request; this is intentional for expert users.
- haze can make substantial changes, and it still needs supervision.

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
