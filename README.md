# haze

A minimal LLM harness for your terminal.

## What's new in 1.0.0

haze 1.0.0 is the first stable release: the CLI flags, settings schema, `stream-json` event contract, session format, skill layout, and structured tool-result shape are now covered by the 1.x compatibility promise. It also lands a configurable model-retry pool and the four benchmark-driven reliability fixes below.

- Configurable model-retry pool: the `modelRetries` setting (integer 0–10, default 2) sizes the shared bounded pool that retries transient model errors and idle-stream stalls. Raise it for providers that terminate long streams aggressively; `0` disables automatic retries (stalls pause with the goal preserved for a one-key resume). The effective pool size is visible in `timeout`/`retry` stream events (`maxRetries`) and stall diagnostics.
- Benchmark-hardened completion evidence (found by the csv-query differential benchmark — same model across four harnesses isolates the harness): `writeFile` chunking guidance can no longer be shadowed by schema validation, reads fail open in Git-less workspaces while mutations still fail closed, the shell validation classifier recognizes Python/Go/Rust/Make/Maven/Gradle/Ruby/.NET/Deno/Bun test commands plus direct runs of files changed this goal, and `shell` accepts `purpose=validation` so ad hoc assertion scripts become structured completion evidence.
- Validated with a differential Harbor benchmark on glm-5.3 (claude-code, nanocoder, pi, haze): haze passed 17/17 verifier tests with the fewest input tokens of the reporting harnesses, a clean goal envelope (1 cycle, structured passing validation), and zero stalls. Full report under [`benchmarks/harbor/results`](https://github.com/DenizOkcu/haze/tree/main/benchmarks/harbor/results).
- Carried from 0.11.0: autonomous goal continuation across physical turns, runtime provenance and stale-install protection, model-aware context budgeting, headless `--timeout`, per-tool deadlines, incremental streaming, and model-written `/compact` summaries.

Previous releases:

- `0.11.0`: goal-level autonomy across physical-turn budgets (logical-goal supervisor, evidence-gated completion, `goal_*` stream events, cumulative goal envelope), runtime provenance and `haze doctor` (embedded build info, stale-build refusal, session build headers), model-aware context budgeting (per-preset limits, live discovery, 128K fallback, self-healing context overflow), headless `--timeout` with per-tool deadlines and abort-cause typing, performance work (batched ignore checks, LSP reuse, coalesced/vacuumed sessions, memoized estimates, incremental streaming, viewport-clamped live region), and model-written `/compact` summaries with a heuristic fallback.
- `0.10.1`: OpenAI Subscription OAuth preset, SECURITY.md and the attended-use threat model, bounded completion recovery, compact colorized diffs, prompt-injection framing, hardened fetch/stdin/sessions, and a multi-page docs site.

- `0.10.0`: image input, read-only path blessings, isolated fleet workers, managed background processes, session browsing and forking, model discovery, project skills, and rotating tips.
- `0.9.0`: private home-state storage, authoritative turn status, collection-time byte bounds, hardened process teardown, stronger real-path and network boundaries, and ordered persistence.
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

### Supervision model

There is **no sandbox and no permission layer**: the shell tool runs unsupervised in your login shell (its classification is informational only), and only the file tools are confined to the workspace. Claude Code gates tools behind permissions, plan mode, and hooks; Codex CLI runs in an OS sandbox with approval modes; haze, like pi, replaces those mechanisms with your supervision. That trade-off is deliberate and keeps the agent fast and transparent, but it also means haze is **not an unattended automation runtime** — run it where you would run a shell session yourself. If a CI job runs haze headless, treat the job the way you would treat any script with shell access. SECURITY.md documents the attended-use threat model in full.

## Getting started

haze runs on macOS and Linux with Node.js 22 or newer. Windows is not yet a supported platform (the toolchain assumes a POSIX shell); it is on the 1.x roadmap.

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

`/provider` sets up any OpenAI-compatible endpoint, such as OpenRouter, OpenAI, LM Studio, Ollama, or a proxy. haze asks for a provider name, base URL, optional API key, and model names. The **OpenAI API Key** preset uses platform API billing. The **OpenAI Subscription** preset instead opens a ChatGPT browser login and uses the Codex Responses endpoint; no pasted session token is required. Its sign-in callback listens on a fixed localhost port (1455) required by the registered client, so a lingering process holding that port blocks sign-in until it exits; retry after freeing the port.

`/model` selects the model haze should use. The picker also offers `add models`, which fetches a provider's model list from its OpenAI-compatible `/models` endpoint so you can pick instead of typing; if the endpoint is unavailable you can still type model names. You can also set one directly:

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

Saved settings live in `~/.haze/settings.json`. ChatGPT OAuth credentials live separately in `~/.haze/auth.json`; both files use private permissions. Provider keys and MCP headers require HTTPS unless the endpoint uses loopback HTTP (`localhost`, `*.localhost`, `127/8`, or `::1`). Keyless HTTP remains available, and local OpenAI-compatible providers do not need a key. If a settings or authentication file is malformed, haze shows an actionable error instead of treating it as empty. Configure everything inside haze with `/provider`, `/model`, and `/settings`; there are no environment variables to set. Provider presets carry curated per-model metadata (context window and output cap from the models.dev catalog) which the wizard writes into `modelLimits`.

haze focuses on chat, local tools, context files, sessions, and Markdown skills. Use `/skills` for workflows outside that core. Its interactive picker can generate a skill from a description, then enable, disable, validate, or remove it. For reviews, release prep, deploy checks, debugging routines, or a team-specific checklist, ask haze to create a skill and edit the resulting Markdown as needed.

## Start using haze

Open a project and ask for work:

```txt
create a calculator in calc-app in ruby with add subtract multiply divide
```

haze can inspect and edit files, fetch public URLs, and run commands. Tool activity stays compact in the transcript. Completed transcript entries render once as static terminal output, which keeps live model and spinner updates from repainting the full history. During a streamed answer, completed root-level Markdown blocks move into that static history while the unfinished block stays plain and live. Small edits show a colorized diff with one line of context on either side; large diffs get a short summary instead. Shell output is capped while the command runs, then filtered according to the command type. Validation failures keep the useful diagnostics. Raw output handles have per-entry and total memory limits, and tell you how many bytes were dropped. Sessions are saved after their first resumable message, so you can pick up the latest workspace conversation with `haze --continue` or `/resume` without accumulating empty session files.

The agent can start up to five dev servers or watchers as registered background processes. Their rolling output is capped at 256 KB and remains available through `readToolOutput`; the `process` tool lists, reads, and kills them. The status bar shows the live count. Starting a new session or exiting haze terminates every registered process tree, while aborting an individual turn leaves background work running. Background processes are unavailable inside fleet workers and never survive haze itself.

Use `/` to discover commands and skills. Type `@` to browse workspace files; `Tab` completes the top suggestion.

Useful starters:

```txt
/init
/skills        # then add skill: name + a description like:
                # "review my current branch against main like a senior engineer"
                # "prepare clean git commits from my uncommitted changes"
                # "implement small features with tests and a concise summary"
```

`/init` creates or updates `AGENTS.md` so future sessions understand the project.

## Attach images

Reference an image in your prompt to attach it, and haze sends it to the model alongside your text:

```txt
@docs/screenshot.png the button in this shot is misaligned — fix it
```

Image input is opt-in per provider. Mark a provider image-capable in `/provider` before attaching, and haze shows which providers accept images in `/settings`. Attachments are limited to png, jpeg, gif, and webp files, up to 5 MB and 4 per message. Explicit user-typed paths may point outside the workspace; this exception is read-only and never expands mutation access. A non-capable provider, an invalid image path, or an oversized file fails with a clear message before any model call. Resumed sessions keep a short placeholder instead of the image bytes.

## Skills that grow with your workflow

Skills are Markdown workflows that haze creates with `/skills`. Choose **this project** to store a team workflow in `.haze/skills`, or **global** to store a personal workflow in `~/.haze/skills`. Project skills override same-named global skills in that workspace; `/skills` always shows each skill's provenance.

If you do something for the second time, build a skill for it:

```txt
/skills
# Picker → add skill
# Name: branch-diff-review
# Description: review the diff between my current branch and main, focusing on bugs, tests, DRY and KISS
```

haze uses the model to create the skill file for you at the explicitly selected scope:

```txt
.haze/skills/<skill-name>/SKILL.md       # project
~/.haze/skills/<skill-name>/SKILL.md     # global
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
/resume [id]
/new
/compact [instructions]
/clear
/exit

/skills
/tips
/fleet [--review] [--profile <name>] [--workers <provider:model>] [--concurrency <n>] <prompt>
```

Skill management is a single interactive picker, mirroring `/provider`, `/lsp`, and `/mcp`: generate a custom skill from a description, then show info, enable/disable, validate, or remove. Disabled skills drop out of the model catalog and the `/<name>` command list until re-enabled.

CLI flags:

```bash
haze --debug         # show model/tool debug logs and write detailed JSONL logs to ~/.haze/logs
haze --continue      # resume the latest saved session for this workspace
haze --resume <id>   # resume an exact session id for this workspace
haze --no-session    # run without durable session storage
```

Non-interactive / print mode:

```bash
haze -p "refactor utils.ts to remove the unused export"
haze -p "summarize this repo" --model openai:gpt-4o-mini
haze --resume <id> -p "continue the investigation"
haze -p "list the top 3 bugs in src/api.ts" --output json
haze -p "audit src/auth.ts" --output stream-json   # live NDJSON events, then the result envelope
echo "what does this project do?" | haze
```

`-p` and `--prompt` run one agentic turn with the full tool set and print the final assistant text. `--model` accepts a bare model name or `provider:name` and overrides the active model for that run without changing `~/.haze/settings.json`. The model must already be registered under a provider's `models`; add it once with `/provider`. Unknown or ambiguous selectors print a specific error to stderr and exit nonzero.

If you pipe stdin without `-p`, haze reads the prompt from stdin. Piped prompts are limited to 256 KiB; for larger input, pass a file path and ask haze to read it. One-shot runs do not create or update durable sessions, and they ignore `--continue`; `--resume <id>` can load an exact saved context for the turn without changing the original session. On a provider context overflow they compact the loaded conversation once, like the interactive path, and retry the same request; if there is too little history to compact, the run fails with a specific message. Add `--debug` to write a detailed JSONL log under `~/.haze/logs/`.

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

The `status` field is authoritative (driven by the agent's terminal state, not by parsing `result`), and the exit code mirrors it: `0` only for `complete`. A run that ends without a substantive final answer, after an unresolved final tool failure, with declared tasks or required validation still unfinished (even if the model wrote a final message) is `failed` even if the provider returned normally; the evidence envelope carries the task counts and validation outcome that gated it. Per-turn step/tool budgets are safety boundaries, not completion: haze automatically continues the logical goal in fresh turns while measurable progress remains, so a budget boundary alone never fails a run. `--timeout` bounds the entire logical goal (not each internal turn). The result envelope additionally carries a `goal` object (physical turns used, stop reason, total mutations, final validation outcome and task counts) when goal-level continuation was involved.

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
- `editFile` makes unique text replacements, tolerates accidental line-number prefixes, and returns a structured diff.
- `replaceLines` edits line ranges when exact replacements are awkward, clamps ranges that extend slightly past EOF, and returns a structured diff.
- `writeFile` creates, overwrites, or appends files and parent directories, returning a diff for each successful content change.
- `shell` runs tests, builds, git and gh commands, scripts, installs, and other command-line work in your configured login shell. Set `HAZE_SHELL` to an explicit executable for deterministic CI or service accounts. Its schema identifies the active shell dialect. Output is trimmed according to the command type while preserving useful failure details. A timeout or abort kills the process tree, escalates if necessary, and returns even when an escaped child keeps stdout or stderr open.
- `readToolOutput` pages through retained raw output omitted from oversized or reduced results, subject to in-memory budgets.
- `fetch` reads public `http(s)` URLs as Markdown, formatted JSON, or text. It rejects non-HTTP schemes, private and loopback addresses, metadata hosts, and malformed IPv6-like hosts. Bounded output remains available through `readToolOutput`.
- `writeTasks` replaces the task list at meaningful phase changes. Completed lists clear on the next user turn.
- `skill` loads an installed Markdown workflow or one of its references.
- `lspWorkspaceSymbols`, `lspSymbols`, `lspDefinition`, and `lspReferences` provide optional read-only navigation through configured language servers. They appear only when an enabled server command is installed.

Tool calls are grouped in the transcript so you can see what happened without reading a novella. Every successful `editFile`, `replaceLines`, and `writeFile` content change shows colored additions and removals with line numbers and context. Large diffs keep an eight-row preview—the first four and last four rows, separated by an omission marker—and expose the complete retained diff through `readToolOutput`; no-op mutations are labeled explicitly. File-tool failures include a reason code and a recovery hint. Large shell, search, and fetch results stay behind an in-memory handle. Later model calls see a compact summary tailored to validation, git, search, diffs, JSON, logs, or the head and tail of the output.

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

The available modes are `inspect` (read-only), `research` (read-only with public fetch), `implement` (file changes and coordinated shell access), and `validate` (reads and coordinated shell access). Read-only modes cannot change files. Workers that can make changes are serialized with each other and with changes from the main turn. This coordination is not a shell sandbox.

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

haze saves durable workspace sessions in `~/.haze/sessions`. It writes a session after the first resumable message, so empty sessions do not create files or appear under `/resume`. Settings, history, sessions, and debug logs use private POSIX directory/file permissions (`0700`/`0600`) and ordered, flushable writes. Use `/session` to see the current file, `/new` to start fresh, and `/resume` to browse workspace sessions, resume one, or fork its latest snapshot into a new session. `/resume <id>` and `haze --resume <id>` select an exact session. Use `/compact` to condense older model context: by default the active model writes a continuity summary of the older history (set `manualCompaction: "heuristic"` in settings to keep the model-free bounded excerpt instead); automatic mid-turn compaction always uses the heuristic excerpt. Sessions also persist compact structured work state: the active goal, touched files, validation evidence, blockers, and next action.

Snapshots are written at turn boundaries, not per tool call. If haze crashes or is killed mid-turn, the session resumes from the last completed turn: work already on disk (file edits, command side effects) is not reflected in the session record, so after a crash verify the working tree (`git status`, `git diff`) before continuing. To keep long sessions from growing quadratically — every turn appends the full history again — session files are automatically compacted once superseded snapshots dominate the file: only the newest conversation and work-state snapshots are kept and the file is rewritten atomically.

Session files are optimized for resume and audit, not token-by-token playback: completed user/assistant messages, tool lifecycle events, conversation snapshots, and work-state snapshots are persisted, but streaming `message_update` events are skipped. Large persisted tool outputs are replaced with previews and byte counts so a resumed model can reread current files instead of carrying stale megabytes forward.

Long turns use bounded tool slices. Older successful tool results are compacted while failures and recent evidence remain verbatim, synthetic haze control nudges are not persisted as user requests, and token-pressure compaction preserves the structured work state.

haze loads project instructions from:

- `~/.claude/CLAUDE.md`
- `~/.haze/AGENTS.md`
- `CLAUDE.md` / `AGENTS.md` files from filesystem root to the current workspace

At the same scope, `AGENTS.md` overrides `CLAUDE.md`; global haze guidance in `~/.haze/AGENTS.md` overrides global Claude guidance in `~/.claude/CLAUDE.md`. Nested `CLAUDE.md` / `AGENTS.md` files below the workspace are scoped: haze surfaces them only when file tools operate inside that directory or its subdirectories, injects newly discovered scoped guidance into the next model step, and mutating tools stop once so the model can review it before editing. Scoped context files are tracked by signature, so changed nested guidance can be read again later in the same session.

Use `AGENTS.md` for project conventions, commands, architecture notes, and anything you do not want to explain again. Because context files are added to every request, `/init` keeps its discovery pass small, preserves useful existing guidance, and asks for a compact file.

## Optional settings

Most haze behaviour needs no configuration; a few optional keys in `~/.haze/settings.json` tune reliability and context handling. All are validated loudly — malformed values fail with a clear settings error instead of being silently ignored.

- `modelRetries` (integer 0–10, default 2): size of the shared bounded retry pool for transient model errors and idle-stream stalls. Raise it for providers that terminate long streams aggressively; `0` disables automatic retries (a stalled stream pauses with the goal preserved for a one-key resume). The effective value is reported in `timeout` and `retry` stream events as `maxRetries`.
- `contextWindowFallbackTokens` / `localContextWindowFallbackTokens` (default 128K hosted / 32K local): context-window guess for models without limits metadata. Every turn emits a `context_budget` event naming the window and its source, and the interactive warning fires once per model per session when the built-in default was used.
- `manualCompaction` (`"llm-summary"` default, or `"heuristic"`): whether manual `/compact` asks the active model for a continuity summary or keeps the model-free bounded excerpt.

## Safety model

haze is designed for attended use by an experienced developer on a single-user machine. It trusts the user and their global `~/.haze` configuration. Repository contents, project skills and instructions, fetched pages, MCP and LSP output, and model output are untrusted. A local attacker who already has access as the same operating-system user is outside this threat model.

Ordinary file and tool output is data, not instructions. The system prompt says that fetched content, MCP/LSP output, and files outside the workspace cannot override its rules. Project context files and project skills are the exceptions: haze loads them as designated instruction sources, labels them as repository-provided content, and keeps them below system and user instructions in priority. Prompt injection cannot be eliminated by labeling alone, so user supervision remains part of the security boundary.

Shell classification is informational. haze does not ask for confirmation before running commands, including commands that can mutate or delete data. This is an intentional trade-off for attended expert use, not a sandbox or permission boundary.

- Model-selected file tools are restricted to the current workspace and follow `.gitignore` by default.
- A path explicitly typed by the user with `@path` or as a slash-containing bare path may grant read-only access for that turn, including outside the workspace. It never grants mutation access.
- Ignored workspace files require an explicit override unless covered by that user-granted read exception. If Git cannot run at all, mutation tools refuse with `ignore_check_unavailable` (the safe direction for writes) — reads still proceed.
- The `fetch` tool only reads public `http(s)` URLs. It rejects other schemes along with private, loopback, link-local, cloud-metadata, and malformed IPv6-like hosts. On every redirect, haze connects to the public IP it already validated, which closes the DNS-rebinding gap.
- Project skills under `.haze/skills` are real-path-confined to the workspace and visibly labeled as untrusted repository content. Review them before using an unfamiliar repository.

With `--debug`, haze writes full request and message payloads to `~/.haze/logs/`. The files use private `0600` permissions on POSIX, but they can contain secrets and file contents. Do not share debug logs without reviewing and redacting them.

See [SECURITY.md](SECURITY.md) for supported versions and private vulnerability reporting.

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

### Running the checkout instead of a global install

A globally installed haze keeps serving its own code even while you work in a checkout — the exact failure mode where a fix lands locally but sessions keep running the old runtime. Two supported ways to run the checkout:

```bash
npm run haze -- <arguments>   # run the source checkout directly, no global install touched
npm run dev:link              # build, link globally, and verify `haze` on PATH resolves to this checkout
```

`npm run dev:link` builds the checkout, runs `npm link`, resolves `command -v haze`, and fails loudly unless the linked binary reports this checkout's version and commit. Restart any running haze process afterward — a live process never hot-swaps its code.

### Runtime provenance and diagnostics

Every build embeds a manifest (`dist/buildInfo.json`: version, commit, build time). The launcher verifies it before starting and refuses incomplete or stale builds with a rebuild hint instead of running partially outdated code.

```bash
haze --version --verbose   # version, commit, runtime/executable paths, goal-supervisor state
haze doctor                # provenance, artifact/manifest checks, capability registry, checkout-mismatch warning
```

Session headers record the executing build (version + commit + build time), so a saved failure can be tied to the code that actually ran. When haze starts inside or below a checkout whose version/commit diverges from the running binary, it prints a startup warning naming both — it never switches runtimes silently.

Package check:

```bash
npm pack --dry-run
```

The npm package ships `bin`, `dist`, README, license, changelog, and examples.

## Release

The documentation site is committed as static HTML under `docs/`; there is no in-repository generator. Before a release, update the version stamps in every `docs/*.html` page and manually reconcile `index.html`, `quickstart.html`, `commands.html`, and `tools.html` with the README and changelog.

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npm audit
npm pack --dry-run
git tag vX.Y.Z
git push origin main --tags
npm publish --access public --provenance
```

## License

MIT
