# AGENTS.md

Last updated: 2026-10-31 for the 1.7.11 release.

Project instructions for haze coding agents. Keep this root file concise; nested `AGENTS.md` files carry precise subtree contracts.

## Project overview

haze is a Node >=22.13 TypeScript ESM CLI package (`@denizokcu/haze`) for terminal-based agentic app building.

Core shape:

- React + Ink interactive terminal chat UI, themed through a built-in palette registry (`/themes`).
- Vercel AI SDK with OpenAI-compatible providers.
- Local tools for file discovery/read/search/edit/write, public URL fetch, foreground and managed background processes, LSP/MCP integration, global/project skills, image attachments, subagents/fleet, task tracking, session browsing/forking, and compaction.
- Source lives in `src/`; generated `dist/` must not be edited.

Verify current package version in `package.json` before release work.

## Common commands

```bash
npm install
npm ci                 # preferred in CI or clean checkouts
npm run dev            # run CLI via tsx
npm run haze           # alias for dev
npm start              # run built dist CLI

npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run lint           # eslint src/
npm run lint:knip      # knip unused-export hygiene
npm run context:report # estimated prompt/tool/context token breakdown

npm run build          # clean + tsc
npm pack --dry-run     # inspect published tarball
```

Before release/PR confidence: `npm run typecheck && npm test && npm run lint && npm run build`.

## Repository map

- `src/` — TypeScript/TSX source. See nested `src/**/AGENTS.md` files.
- `tests/` — Vitest suite. See `tests/AGENTS.md`.
- `bin/haze.js` — thin npm binary shim to built CLI.
- `dist/` — generated build output; never edit directly.
- `website/` — Astro source for the public site; run `npm run sync --prefix website` after editing and commit the generated `docs/` public files. `npm run check --prefix website` detects drift.

## Global coding conventions

- Strict TypeScript, ESM (`type: "module"`), NodeNext module resolution, ES2022 target.
- Local TypeScript imports use `.js` extensions.
- Prefer plain TypeScript for core logic; keep React/Ink in CLI/UI layers.
- Use Zod for AI SDK tool schemas and generated-object schemas.
- YAML parsing/writing uses the `yaml` package.
- Avoid `any`; prefer `unknown`, type guards, or existing result types.
- Preserve local formatting style; avoid broad formatting churn.
- ESLint: unused vars are errors unless args start with `_`; `no-explicit-any` is an error.

## Editing rules

- Check `git status --short` before large work; do not overwrite unrelated user edits.
- Never edit `dist/`, `node_modules/`, `.git/`, generated outputs, secrets, or ignored runtime state.
- Do not edit `package-lock.json` unless dependency changes require it.
- Prefer targeted edits over whole-file rewrites for source.
- Do not commit, tag, publish, reset, delete, force-push, or run destructive cleanups unless explicitly requested.

## Runtime contracts to preserve

Recent decisions to preserve:

- Runtime support floor is Node >=22.13 (set by eslint 10's engine range). Keep docs, package metadata, and generated docs aligned.
- Provider/model selection is explicit. `/reasoning` selects a session-scoped model override; `off` means `none`, `unset` omits the parameter, and `reset` drops the override. Resolution order is run override → session per-model → global setting → `low`. `config/providerReasoning.ts` supplies the shared provider/model profile for UI and requests; unknown endpoints omit effort unless configured. Custom providers may set `reasoningLevels`, `modelReasoningLevels`, or binary `reasoningFormat`. Workers use the lowest known supported level, otherwise provider default; compaction uses the resolved active policy. OpenRouter carries effort in provider options and preserves structured reasoning details.
- Settings parsing should fail loudly for malformed files and preserve unrelated/unknown fields when patching.

- No default provider/model. Users configure providers via `/provider`; no user-facing env vars for provider/model settings.
- Native `haze.build` uses `haze1.5-builder-flash`; older deployments may use `haze0.1-coder-flash`. Its `haze-build` kind uses the versioned manifest, binary thinking and reasoning-preserving adapter; it never activates from an arbitrary provider name or URL. haze-gpu serves Haze agents only: the client owns per-request sampling (0.6/0.95 thinking-on or unset, 0.7/0.8 thinking-off, top_k 20 — `llm/hazeBuild.ts`), and uses the patient idle-stream class regardless of URL (`usesPatientIdleWindow`). This silent-testing alpha is excluded from public surfaces; operator documentation lives in the internal haze-gpu repository.
- The provider surface stays OpenAI-compatible (plus the `chatgpt-codex` OAuth kind). Direct OpenAI GPT-6 and Codex use Responses; OpenRouter uses its official adapter to preserve reasoning details; other compatible endpoints use `@ai-sdk/openai-compatible`. Custom endpoints are selected by URL/protocol, never model name alone.
- File tools are confined to `process.cwd()`, respect `.gitignore` by default, and skip `.git`/`node_modules` walking; user-typed `@path` mentions and bare paths containing `/` are the exception and may bless host paths outside it for read-only tools (readFile, grep, listFiles). Mutating tools never honour the bless set. URL safety fails closed for malformed IPv6-shaped literals.
- Secret files are hands-off for the file tools, always: SSH keys (`~/.ssh/**`, `id_*` private keys), shell history files, `.env`/`.envrc` (except `.example`/`.sample`/`.template` doc variants), `*.pem`/`*.key`/`.ppk`/`.p12`/`.pfx`, service-account/firebase JSONs, and home credential stores — `.netrc`-class files, `.pgpass`/`.my.cnf`/`.msmtprc`, other agent CLI stores (`.claude`/`.codex`), cloud configs (`.snowsql`/snowflake/`.oci`/`.netlify`/`.travis`), browser profile dirs, and exactly `~/.haze/settings.json` + `~/.haze/auth.json` (files only; sessions/logs stay readable) — enumerated in `core/safety/secretPaths.ts`. Reads and mutations are refused before any filesystem access with a terminal structured result (reason code `secret_file_protected`, `recoverable: false`, ask-the-user next step, no content echoed; UI labels it `blocked: protected secret file (path)`), the check covers lexical and real paths so symlinks cannot rename secrets into reach, and it overrides the bless set and `allowIgnored`; grep traversal excludes the names with negated-only globs appended after any model glob. The shell tool is deliberately not hard-filtered; shell-side secret avoidance is instructed via the system prompt (`SECRET_FILE_RULE`), and `secretPaths.ts` and `SECRET_FILE_RULE` must change together — a canary test pins the rule's category tokens.
- Security hardening invariants (2026-10-31): file tools refuse git internals — mutations under any `.git`/`*.git` directory or worktree-resolved git dir are terminal (`git_internals_protected`), as are reads of git `config`/`credentials`/`hooks` (incl. `modules/**`); multi-link files (`nlink > 1`) are refused (`multi_link_file_protected`, recoverable) so hardlinks cannot launder secrets; new-file writes never follow dangling symlinks. The URL guard allows only ports 80/443 (`blocked_port`), re-validated per redirect hop.
- Untrusted-content labeling is structural (2026-10-31): fetch and MCP results of every size carry escaped `<web_content>`/`<mcp_result>` envelopes (oversized pages behind a handle, re-wrapped on every read). Envelope closers of all five container kinds are escaped variant-tolerantly (case/whitespace) by one shared escaper (`core/safety/untrustedEnvelopes.ts`), which also neutralizes context-path attribute breakouts. Late-discovered scoped AGENTS.md/CLAUDE.md (main turn and subagents) ride ordinary user messages with the startup framing — the per-process-nonce'd `<haze_control>` channel is engine directives only. Compaction summaries are origin-labeled (`<haze_compaction source="data">`) with closers escaped. Terminal control sequences (CSI/OSC/DCS/APC/PM incl. C1) are stripped at Ink sinks and the Markdown transcript path (root text prep + code-highlight input; `ui/terminalSanitize.ts`). Opt-in: `sanitizeProcessEnv`(+`Extra`) strips secret-shaped env from spawned processes; `redactSessionSecrets` redacts token-shaped secrets in sessions (`--debug` logs always redacted).
- Output is aggressively bounded/reduced but raw large outputs may be retrievable by handle. Exact line paging uses bounded, signature-validated sparse indexes; subprocess teardown must not hang when escaped descendants retain stdio pipes; ignore rules are evaluated in-process from the repository/worktree boundary without requiring Git (reads fail open, mutation guards fail closed).
- Failed file mutations activate read-only recovery only when their structured result explicitly requests `readFile`. Recovery state advances in the AI SDK's ordered `onStepEnd` callback, compares lexical workspace path identity (`a.ts` and `./a.ts` are equivalent), and repeated identical tool calls are redirected with a one-step instruction appended to the next request (never by removing tools from the request, which once let a model retry the removed tool and fail the step), bounded per attempt; recognized validation reruns (unquoted shape infers the validation kind) are never repeats, and a trailing bare stderr redirect (`2>&1`, `2>/dev/null`) is check-identity noise so a red `cd pkg && npm … 2>&1` pairs with the plain green rerun.
- Abort causes are distinguished (user / model-stream idle stall; the absolute turn deadline is opt-in — no implicit cap unless the headless `--timeout` whole-goal budget clamps the turn). An idle stall with no emitted step output retries via the shared bounded model-retry pool (sized by the `modelRetries` setting, default 2, range 0–10; the idle window via the `streamIdleTimeoutMs` setting, default 5 min hosted / 30 min for the patient class — loopback-local servers and native `haze-build` deployments (`usesPatientIdleWindow`), whose silent prefill emits no stream parts; backoff base `retryBaseDelayMs`, default 1000ms; reported as `maxRetries` in events), salvaging the conversation to the last completed step; the pool resets whenever a failed attempt completed steps since the previous retry, and an exhausted stall pauses the turn (status `failed`) preserving the active goal and exposing a one-key R resume interactively. Provider context-overflow errors recover through bounded compact-and-retry attempts with a progressively shrunk message budget (0.6 → 0.36), after which the goal checkpoints (`context_exhausted`) instead of hard-failing; silent and length-stop overflows are detected from provider usage through the classification table in `core/agent/overflow.ts`, and context estimation prefers provider usage via the turn-scoped usage anchor. Mid-turn compaction at epoch boundaries uses an LLM-written summary (iterative, split-turn aware) for large older halves and the heuristic excerpt otherwise. An attempt that ignores cancellation past a grace window is forcibly settled: owned resources close exactly once (bounded), its callbacks are permanently quarantined so late output cannot mutate the finished turn, and the turn resolves `aborted` with a truthful teardown report.
- Completion is evidence-gated, not text-gated: a voluntary final is rejected while this turn's `writeTasks` list has pending/in-progress items or post-mutation validation is missing/stale/failed (implement/fix/test intents). Red→green is opportunistic: a fix need not capture a pre-edit failure, but if a recognized validation does fail before the first mutation, that same command must pass after the fix. Known test/build commands count automatically; custom checks use `shell` with `purpose=validation` so real process results become structured evidence. Authority rules: validation-classified commands run under `pipefail` (POSIX), a passing validation whose unquoted command can mask a failing stage (`;`/`||`/`&` compounds) is demoted to unconfirmed (`generic`), validation-kind inference matches only the unquoted command shape, `&&`-chained compounds record per stage so a green chain clears each stage's own kind/scope (while `cd pkg && <single npm>` stays one path-scoped check and `;`/`||` chains stay opaque), and a passing generic validation never clears a failed classifier-confirmed one (eval-hardened). Rejected finals trigger autonomous continuation inside the same logical turn and budgets; the logical-goal supervisor (`runAgentGoal`) spans physical turns, so a step/tool budget boundary (incl. `tool-calls` finishes) starts a fresh continuation turn on the preserved conversation while measurable progress continues and the goal deadline remains. Inside each attempt, every `ToolLoopAgent` instance is one completed SDK step wide: exact provider messages append into the next instance so prompt-cache prefixes survive routine resource rollover, while SDK result/step graphs become collectible. Active provider history and durable conversation snapshots are lossless; only true context-budget compaction or an explicit provider transition may rewrite the provider prefix. Every supervisor boundary appends to a durable, crash-safe, resume-aware goal ledger in the session JSONL; headless `--until-done` relaunches transient failures against it with a no-progress poison guard. It stops only for structured completion, hard blockers, user cancellation, the goal deadline, context exhaustion (`context_exhausted` — pauses at the resumable checkpoint instead of relaunching the oversized request), or one corrective physical turn without measurable outcome progress — never reporting incomplete work as `complete`. Old workspace task files never block unrelated turns; carried evidence hydrates continuation turns via seq baselines so validation debt survives the boundary.
- Session state is JSONL under `~/.haze/sessions`; new sessions stay memory-only until the first resumable message, empty legacy files stay out of resume/latest listings, persisted sessions skip streaming `message_update` spam and preserve full conversation snapshots, and file LLM logging under `~/.haze/logs` is enabled only by `--debug`. Each session records a `model_selection` entry restored on resume, continue, and fork, so changing the global default never rewrites an active session's model; headless `--resume` follows the saved selection unless `--model` is explicit. `haze report [id] [--json]` summarizes a session from bounded metadata only (never prompts, commands, paths, or tool output).
- Model switching converts prior tool calls and results to labeled text and removes provider-specific reasoning state before replay; never forward opaque continuation across model boundaries. Model steering for compact models is opt-in via the `steeringProfile: "compact"` setting (smaller working slices, earlier validation reminders, compaction at 70% of the usual message budget) and never weakens completion evidence; `escalationModel` (a validated `provider:model` selector) hands a no-progress or context-exhausted goal to that model exactly once, keeping the conversation and evidence and announcing the switch. Haze never chooses a fallback model on its own.
- The Ink transcript is append-only static output above a dynamic tail. Streamed assistant Markdown renders as formatted terminal rows in the dynamic tail (the active root rendered offscreen by the settled Markdown renderer, outside React render/commit phases) while whole-block parsing stays intact; only parser-stable preceding roots move into static output, and the final root settles on completion. The dynamic tail (streaming roots, live tool groups, task bar) is clamped to a viewport-derived row budget so Ink never enters its scrollback-wiping overflow path; row estimates mirror Ink's own `wrap-ansi` wrapping. Clamped rows enter `<Static>` verbatim once settled — never lost. Width changes are the deliberate replay exception: `chat/resizeGuard.ts` clears the viewport before Ink's resize handler and the width-keyed `<Static>` remount re-renders all settled history. The input draft and active turn stay mounted; scrollback may retain older transcript copies.
- Context files: global `~/.haze/AGENTS.md` wins over `~/.claude/CLAUDE.md`; ancestor `CLAUDE.md`/`AGENTS.md` load at startup; nested subtree files load lazily when tools touch that subtree and are reread when their signature changes.
- Skills are Markdown instruction packages under global `~/.haze/skills/<name>/SKILL.md` or project `<workspace>/.haze/skills/<name>/SKILL.md`; they do not execute code. Project skills are untrusted repo content, real-path-confined to the workspace, visibly labeled, and take precedence over same-named global skills unless the project scope is disabled.
- Themes are a settings-name-keyed registry: every built-in theme is one data entry in `src/ui/themes/registry.ts` (`purple` is the base/default spec), `resolveTheme` validates names loudly and `tests/ui/theme.test.ts` pins the registry keys and completeness. `theme` in settings selects the palette; `/themes` (picker or `/themes <name>`) switches it live — ChatScreen re-resolves on settings change. A theme owns both terminal defaults: OSC 10/11 are adopted at startup and restored on exit (`src/ui/terminalColors.ts`); already-rendered `<Static>` keeps its old colors until a width-change replay uses the current palette.
- The code graph (`src/core/graph/`, contract in its nested `AGENTS.md`) is a persistent deterministic symbol map built with tree-sitter WASM (js/ts/tsx/jsx; grammars vendored in `assets/graph-grammars/`; runtime pinned to web-tree-sitter 0.23.x), stored under `~/.haze/graphs/<workspace-key>/` — never in the user's repo. Surface: `graphQuery`/`graphExplain`/`graphPath`/`graphAffected`/`graphRebuild` tools (read-only graph tools also reach subagent workers) and `/map`. Edges keep `EXTRACTED`/`INFERRED` confidence in tool output; results are advisory orientation — never validation evidence — and staleness (signature or `EXTRACTOR_VERSION` mismatch) is annotated on every result. Builds are explicit and incremental; no watcher daemon; `EXTRACTOR_VERSION` bumps with any extraction-logic change; mutations attach a bounded reverse-dependency advisory; compaction prompts may carry a bounded graph digest.

## Testing expectations

Run validation appropriate to the change:

- General source: `npm run typecheck`, `npm test`, `npm run lint`.
- Build/package: also `npm run build` and `npm pack --dry-run`.
- Tool behavior: targeted `tests/hazeTools/*` plus relevant formatter tests.
- Validation parser: `tests/core/validationParser.test.ts`.
- Skills: `tests/skills/*` and example skills if public contract changes.

If validation is skipped, state why in the final response.

## Spec-Kit

This repository uses the [spec-kit](https://github.com/github/spec-kit) workflow for AI-assisted feature development: feature specs, plans, and tasks live in `.specify/` and are generated by an opinionated local tooling layer; the spec-kit repo is the source of truth for the workflow itself.

### `.specify/` directory

| Path | Purpose |
|------|---------|
| `.specify/templates/` | Markdown templates for specs, plans, tasks, and checklists |
| `.specify/memory/` | Long-lived context files (e.g. `constitution.md`) read by agents |
| `.specify/scripts/` | Helper shell scripts for common workflow steps |
| `.specify/hooks.yml` | CI/automation hook definitions |

### How to use it

- Start a new feature: `/speckit-specify` — creates a spec from a template and opens a clarification loop.
- Generate a plan: `/speckit-plan` — converts an approved spec into a structured plan.
- Break into tasks: `/speckit-tasks` — decomposes a plan into trackable tasks.
- Implement: `/speckit-implement` — works through tasks and updates checklists.
