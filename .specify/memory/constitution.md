<!--
==============================================================================
  Sync Impact Report
==============================================================================
  Version change: 1.1.0 → 1.2.0 (MINOR: one principle added and existing
  resource/orchestration guidance materially expanded).
  Context: Updated after the 2026-08-03 full-codebase review of the current
           /fleet and context-isolated subagent implementation.

  Amendment 1.2.0 (2026-08-03):
    - Principle II now records /fleet as the sole approved native workflow
      exception. It remains a thin command over the existing subagent tool.
    - Principle III now covers bounded memory, exact-page indexing, deadlines,
      cancellation, process-tree teardown, and physical quarantine.
    - Principle IV now requires fail-closed malformed IP-literal handling and
      connection pinning to the validated address at every redirect hop.
    - Added Principle IX, 'Controlled Delegation and Parallel Work', covering
      fresh worker context, fixed mode toolsets, explicit profiles/models,
      hard admission limits, mutation coordination, and capsule-only handoff.

  Modified principles:
    - II. Minimal Core, Skills as First-Class Tools
    - III. Bounded Resources and Lifecycles
    - IV. Strong Real-Path Boundaries and Network Safety
  Added principles:
    - IX. Controlled Delegation and Parallel Work
  Removed sections: none.

  Templates requiring updates (propagation checklist):
    - .specify/templates/plan-template.md   — ✅ compatible. Constitution Check
      remains generic and can evaluate delegation, lifecycle, and exception
      requirements without a structural template change.
    - .specify/templates/spec-template.md   — ✅ compatible. No mandatory spec
      section was added or removed.
    - .specify/templates/tasks-template.md  — ✅ compatible. Existing test and
      quality-gate phases can carry coordinator, cancellation, and persistence
      tasks.
    - .specify/templates/commands/*.md      — N/A. No commands/ directory exists.
    - README.md / docs/index.html           — ✅ already describe /fleet,
      context-isolated workers, explicit profiles, quarantine, and mutation
      serialization.
    - src/core/subagent/AGENTS.md, src/llm/AGENTS.md,
      src/cli/commands/streaming/AGENTS.md — ✅ already aligned with Principle IX.

  Follow-up TODOs: none for propagation. Code-review findings are reported
  separately and do not change the governance contract.
==============================================================================
-->

# haze Constitution

## Core Principles

### I. Expert-Oriented, Light Guardrails (NON-NEGOTIABLE)

haze is built for expert developers who keep their hands near the wheel, not
for a permission-dialog factory.

- No command confirmation gates. Bash command classification is **metadata**
  for display, logging, validation parsing, and output reduction — it MUST NOT
  block execution by itself.
- Mutating and destructive commands MAY run when they are relevant to the
  user's explicit request; this is intentional.
- Tool calls are surfaced transparently (grouped, compact activity) so the user
  can watch them, not approve them.

Rationale: the product identity is an expert-oriented tool. Removing guardrails
is a feature; the contract is "powerful enough to help and dumb enough to
deserve supervision."

### II. Minimal Core, Skills as First-Class Tools (NON-NEGOTIABLE)

haze ships a deliberately small, stable core — chat, a small native toolset,
context files, sessions, and Markdown skills. The user builds the harness; the
core does not grow to absorb every workflow.

- haze MUST stay minimal. New workflow/ritual capability (reviews, release
  prep, deploy checks, debugging rituals, team checklists) MUST normally be
  added as a user-created skill, NOT as a built-in feature. Growth of the
  native toolset MUST be justified, not incidental.
- `/fleet` is the sole approved native workflow exception: it is a thin,
  ephemeral command wrapper over the existing `subagent` tool and MUST NOT
  create a second orchestration primitive or add another model-facing tool.
  Any further native workflow exception requires an explicit constitution or
  feature-plan exception with the simpler skill alternative documented.
- Users extend haze through skills created with the `/skills` picker (or
  generated from a description) and stored as Markdown under
  `~/.haze/skills/<name>/SKILL.md`. Skills are the primary, intended extension
  mechanism — "do normal work, notice friction, create a skill, keep going."
- User-created skills are FIRST-CLASS objects for the model, on the same level
  as native tools: each installed skill is invocable as a `/<name>` slash
  command and discoverable through the single `skill` catalog tool, alongside
  the built-in tools — never subordinate to them.
- Skills are Markdown instructions only; they MUST NOT execute code. They load
  one workflow body first and fetch large references only when requested.

Rationale: the core stays small and trustworthy while the user's workflow
adapts to them, not the other way around. Because the model treats a
user-authored skill as a peer to a native tool, the harness is whatever the
user builds with it.

### III. Bounded Resources and Lifecycles

Collectors, readers, processes, network calls, and delegated work MUST bound
memory growth and MUST NOT leave a turn waiting forever on an abandoned
resource.

- All collection-time and storage-time byte budgets MUST live as named
  constants in `src/core/limits`. Callers MUST cite a constant, never a magic
  number. UI-only display limits and scheduler counts MAY use separately named
  constants in their owning modules.
- Bash/grep subprocess `stdout`+`stderr`, file reads, `fetch` bodies, LSP
  frames/headers/aggregate buffers, stored tool-output handles, skill files,
  and exact-mutation inputs MUST be bounded before their full content is
  resident in memory.
- Exact line paging MAY perform a streaming full-file scan when an exact total
  line count is part of the public result, but it MUST keep memory bounded,
  cache only a bounded sparse byte-offset index, validate the file signature,
  and never silently skip unread lines between pages.
- Byte limits are byte limits for multibyte UTF-8. Truncation MUST preserve a
  valid UTF-8 prefix (flush the decoder tail only when nothing was omitted from
  that stream).
- Omitted bytes MUST be reported truthfully (`retainedBytes`/`omittedBytes`).
  Raw output MAY remain retrievable behind bounded in-memory handles with
  per-entry and aggregate LRU budgets — never unbounded.
- Potentially blocking process, network, provider, integration, and worker
  operations MUST accept cancellation and have an explicit deadline or bounded
  cleanup path. A timeout or abort MUST terminate owned process trees, escalate
  when graceful shutdown fails, and settle even when a descendant retains an
  output pipe.
- Logical cancellation MAY return control before uncooperative work physically
  stops only when that work is quarantined and continues to hold its real
  concurrency and mutation capacity until settlement. A busy marker MUST NOT
  disable all hard lifecycle bounds indefinitely.

Rationale: a runaway process, file, server response, provider call, or worker
MUST NOT exhaust memory, stall a turn forever, or resume unsafe work after its
capacity has been reassigned.

### IV. Strong Real-Path Boundaries and Network Safety

The agent runs with the user's privileges; boundaries MUST prevent accidental
exfiltration, traversal, and local-network reach.

- File tools MUST confine to `process.cwd()` via shared workspace path helpers
  and MUST follow `.gitignore` by default. Ignored paths require an explicit
  override (`allowIgnored`/`includeIgnored`).
- Real-path confinement (`assertRealPathInsideRoot`/`assertPathInsideRoot`)
  MUST be reused across file tools, workspace-owned context files, workspace
  runtime state, skills, LSP, and the skill registry so symlink escapes are
  rejected. A repository-controlled `AGENTS.md`, `CLAUDE.md`, or `.haze` path
  MUST NOT follow a symlink to read or overwrite data outside its allowed root.
- The `fetch` tool MUST allow only public `http(s)`, blocking private,
  loopback, link-local, multicast, unspecified, cloud-metadata, and malformed
  IP-shaped hosts. Literal parsing MUST fail closed. Every hostname and
  redirect hop MUST be resolved and validated, and the connection MUST be
  pinned to an address from that validation so DNS cannot change the target
  between policy check and connect.
- Credentialed remote plaintext HTTP MUST be rejected (configuration and
  runtime); loopback HTTP remains supported. Secrets, API keys, and masked
  inputs MUST NEVER be logged at full or surfaced in UI text.

Rationale: with no confirmation gates, filesystem and network boundaries are
the primary safety mechanism and MUST hold under symlinks, redirects, and
ignored roots.

### V. Authoritative, Truthful Status (NON-NEGOTIABLE)

Turn and tool status is the single source of truth across UI, events, logs,
sessions, and headless exit codes.

- Status MUST be computed exactly once per turn from runtime facts
  (`turnOutcome.ts`); status inference MUST NOT be duplicated elsewhere.
- A turn that ends without a substantive final answer, after an unresolved
  final tool failure, or at a hard step/tool budget MUST report `failed` even
  when the provider returned normally.
- Headless exit codes MUST mirror status: `0` only for `complete`.
- UI "busy" status, work-state text, and persisted events MUST agree with this
  authoritative status.

Rationale: status drives autonomous harnesses and CI exit semantics. An
optimistic-but-wrong `complete` is a correctness bug, not a cosmetic one.

### VI. Deterministic, UI- and Provider-Agnostic Core

The agent loop MUST be testable, provider-portable, and resumable.

- `src/core/**` modules MUST be UI-agnostic (no React/Ink imports, no CLI mode
  state) and MUST NOT depend on configured provider settings except where
  explicitly passed in.
- Prefer pure, deterministic functions. Isolate filesystem, network,
  child-process, and terminal effects in explicit modules. Avoid process-global
  mutable state; if unavoidable, expose reset/clear helpers and cover them.
- Durable business state (sessions, settings, history, tasks, logs) MUST
  persist via `config/`/`core/` modules — never solely in React state.
- Serialized shapes (sessions, tasks, tool/result summaries) MUST be
  backward-tolerant across upgrades and remain protocol-safe AI SDK
  `ModelMessage` values.

Rationale: a clean, effect-isolated core is what keeps multi-provider support,
durable resume, and fast unit tests possible.

### VII. Explicit Configuration, No Defaults, No Telemetry

haze is transparent and opt-in by default.

- There MUST be no default provider or model. Resolution requires explicit
  saved settings; an unknown or ambiguous selector MUST exit non-zero with a
  precise error.
- There MUST be no user-facing environment variables for provider/model
  configuration. Users configure via `/provider`, `/model`, and `/settings`.
- Detailed LLM logs are OFF by default and written only with `--debug`. No
  telemetry is collected.
- Settings parsing MUST fail loudly (actionable error, settings path) on
  malformed input, MUST preserve unknown fields when patching, and MUST NEVER
  invent a provider or model.

Rationale: explicit configuration and opt-in detail prevent silent behavior
changes and respect user privacy.

### VIII. Private, Ordered, Durable State

User state is private by default and crash-safe.

- All `~/.haze` home-state writes (settings, sessions, logs, history, update
  cache) MUST go through `config/privateStorage.ts`: `0700` directories and
  `0600` files, atomic/append writes, and opportunistic tightening of
  pre-existing overly-broad modes.
- Durable writers MUST preserve append invocation order (one writer per file,
  not one global lock) and MUST `flush()` at turn end, session switch, log end,
  and shutdown. The FIRST error MUST be captured and rethrown; later writes
  MUST NOT mask it. Persistence failures MUST be surfaced as one concise
  warning, never swallowed.
- Session JSONL is optimized for resume and audit: streaming `message_update`
  events and large tool outputs MUST be slimmed to previews + byte counts, and
  malformed JSONL lines MUST be reported with 1-based line numbers rather than
  silently replaced with empty defaults.

Rationale: secrets and transcripts stay private by default; ordered, flushable
writes prevent state corruption and silent data loss on crash or shutdown.

### IX. Controlled Delegation and Parallel Work

Subagents exist to isolate noisy work from the main context. Parallelism is an
optional scheduling benefit, not permission to copy the parent conversation or
run unbounded work.

- A worker MUST receive one bounded, self-contained task capsule and a fresh
  context. It MUST NOT inherit parent or sibling conversation history,
  accumulated parent subtree instructions, fleet control prose, or private
  worker transcripts. It MUST independently load root and applicable scoped
  `AGENTS.md`/`CLAUDE.md` guidance with the shared precedence/signature rules.
- Worker modes MUST map to fixed code-owned toolsets. Model-authored arbitrary
  tool allowlists are forbidden. Read-only modes MUST omit mutation tools and
  bash when bash cannot be enforced as read-only.
- Worker model and profile selection MUST be explicit. Missing, unknown, or
  ambiguous configured selectors MUST block delegation rather than fall back
  to the first provider, model, or an inferred endpoint capability.
- The turn-scoped coordinator MUST hard-enforce concurrency, per-execution tool
  calls, deadlines, cancellation truth, and exactly one logical terminal result.
  Parent cancellation, deadline, provider failure, policy block, no output, and
  step/tool limits MUST remain distinct outcomes.
- Mutation-capable workers and main-turn mutations MUST share one retry-wide,
  reentrant workspace mutation policy. Quarantined mutation work retains its
  lease until physical settlement. Coordination is conservative and MUST NOT be
  represented as a shell sandbox or transactional filesystem isolation.
- Only the compact result capsule enters parent model context. Bounded telemetry
  MAY feed live UI, accounting, and debug logs, but result handles are
  process-local and durable sessions MUST not depend on them.
- `/fleet` MUST remain parallel-only and ephemeral: persist the original user
  invocation and compact result capsules, not synthetic orchestration control or
  per-run overrides. If fewer than two independent tasks exist, it MUST decline
  rather than invent parallel work.

Rationale: delegation saves context only when the worker boundary is real.
Hard admission, truthful outcomes, and retained physical capacity prevent
parallel work from becoming hidden cost, stale mutation, or unsafe overlap.

## Technology Stack and Conventions

- **Runtime**: Node `>=22`. Package `@denizokcu/haze`, MIT-licensed, published
  to npm (`dist`, `bin`, README, LICENSE, CHANGELOG, `examples`). The npm
  binary shim is `bin/haze.js`.
- **Language**: strict TypeScript, ESM (`"type": "module"`), NodeNext module
  resolution, ES2022 target. Local TypeScript imports MUST use `.js`
  extensions. Avoid `any`; prefer `unknown`, type guards, or existing result
  types (ESLint: unused vars are errors unless prefixed `_`; `no-explicit-any`
  is a warning).
- **AI layer**: Vercel AI SDK v7 (`ai`, `@ai-sdk/openai`, `@ai-sdk/mcp`).
  Tool schemas and generated objects MUST use Zod. MCP tools are optional per
  turn, MUST be isolated on failure, and MUST never shadow built-ins.
- **Skills**: the first-class extension surface. User-created skills live as
  Markdown under `~/.haze/skills/<name>/SKILL.md`, are managed via the
  `/skills` picker, and reach the model as `/<name>` slash commands plus the
  single `skill` catalog tool — peers to native tools, not subordinate to them.
- **UI layer**: React 19 + Ink 7. Presentation lives in `src/ui/**`;
  orchestration lives in `src/cli/**`. Theme values (`theme.ts`) MUST be used
  instead of hardcoded colors. No new Markdown-rendering dependencies without
  clear justification.
- **Tooling**: YAML via the `yaml` package; ripgrep via `@vscode/ripgrep`;
  Vitest for tests; ESLint + `typescript-eslint` for linting.
- **Naming**: standardized lowercase `haze` across CLI, package, and docs.
- **Public contract**: anything surfaced through slash commands, tool result
  shapes, session/settings/skill files, or the README is public. Changes to a
  result object MUST update its formatters and snapshot/inspect tests.
- **Generated output**: `dist/` is build output and MUST NOT be edited
  directly. `package-lock.json` MUST NOT be edited unless a dependency changes.

## Development Workflow and Quality Gates

- **Architecture boundaries**: business logic lives in `core/`, `config/`,
  `llm/`, `skills/`, or `utils/` unless it is inherently UI orchestration.
  React/Ink rendering and interaction state live only in `cli/` and `ui/`. AI
  SDK tool definitions/schemas live in `llm/`; provider/settings persistence
  lives in `config/`.
- **Test mapping**: `src/<area>/**` ↔ `tests/<area>/**`. Tests MUST be
  deterministic and isolated from the real `~/.haze` home/config — use temp
  directories and mocks; never read real `settings.json` or print secrets.
- **Validation gates** before PR/release:
  `npm run typecheck && npm test && npm run lint && npm run build`.
  For packaging, also `npm pack --dry-run`. `npm run context:report` estimates
  prompt/tool/context tokens without reading `~/.haze`.
- **Regression-first**: add a regression test for every bug fix before or
  alongside the change; cover both success and recoverable failure paths;
  assert contract fields (handles, reduction metadata, recovery hints).
- **Tool/prompt synchronization**: when adding, removing, or changing a tool or
  result shape, update the schema + descriptions, `systemPrompt.ts`,
  formatters/CLI display, and the relevant tests in one change.
- **Editing discipline**: prefer targeted edits over whole-file rewrites for
  source. Never edit `dist/`, `node_modules/`, `.git/`, generated outputs, or
  secrets. Preserve local formatting; avoid broad formatting churn.
- **Release**: tag `vX.Y.Z`, push `main --tags`, then
  `npm publish --access public`. `prepublishOnly` runs typecheck + build.

## Governance

- This constitution is the stable, high-level contract for haze. It supersedes
  ad-hoc practice for the areas it covers. Nested `AGENTS.md` files and the
  README provide runtime development guidance beneath it; on conflict, the
  constitution wins for governance and principle decisions.
- **Compliance review**: every feature plan MUST pass its Constitution Check
  gate before Phase 0 research and MUST be re-checked after Phase 1 design.
  Every PR/review MUST verify compliance. Complexity that violates a principle
  MUST be justified (violation, why needed, simpler alternative rejected) in
  the plan's Complexity Tracking table.
- **Amendment procedure**: an amendment MUST (a) update the principle text,
  (b) bump `CONSTITUTION_VERSION` per semantic versioning, (c) set
  `Last Amended`, and (d) propagate to dependent artifacts (plan-template
  Constitution Check, spec requirement alignment, task categorization, and any
  README/docs that reference the changed principle).
- **Versioning policy**:
  - MAJOR — backward-incompatible governance: a principle removed or
    fundamentally redefined (e.g., dropping the non-negotiable status rule).
  - MINOR — a new principle/section added or materially expanded guidance.
  - PATCH — clarifications, wording, typo fixes, and non-semantic refinements.
- If version-bump type is ambiguous, the proposer MUST state reasoning before
  finalizing.

**Version**: 1.2.0 | **Ratified**: 2026-07-25 | **Last Amended**: 2026-08-03
