<!--
==============================================================================
  Sync Impact Report
==============================================================================
  Version change: 1.0.0 → 1.1.0 (MINOR: new core principle added).
  Context: Initially ratified 2026-07-25 (1.0.0) from README.md,
           docs/index.html, package.json, the comprehensive-review remediation
           docs, and every nested src/**/AGENTS.md + tests/AGENTS.md file.

  Amendment 1.1.0 (2026-07-25): Added Core Principle II 'Minimal Core, Skills
    as First-Class Tools' — haze is a minimal agent that the user extends via
    skills created with /skills; user-created skills are first-class,
    peer-to-native-tools objects for the model. Former principles II–VII were
    renumbered to III–VIII.

  Modified principles: n/a (initial adoption).
  Added sections (all new):
    - Core Principles I–VIII (II added in 1.1.0)
    - Technology Stack & Conventions
    - Development Workflow & Quality Gates
    - Governance
  Removed sections: none.

  Templates requiring updates (propagation checklist):
    - .specify/templates/plan-template.md   — ✅ compatible. Its Constitution
      Check gate defers to "constitution file" and is intentionally generic;
      the principles below are testable, so no edit is required.
    - .specify/templates/spec-template.md   — ✅ compatible. Uses the same
      MUST/SHOULD vocabulary; no mandatory spec section added or removed.
    - .specify/templates/tasks-template.md  — ✅ compatible. Test-first phases
      and quality-gate tasks already align with the test discipline in the
      Development Workflow section; no new task category mandated.
    - .specify/templates/commands/*.md      — N/A. No commands/ directory
      exists in this workspace.
    - README.md / docs/index.html           — ✅ already aligned (these were
      sources for the constitution, not dependents).
    - src/skills/AGENTS.md                  — ✅ already aligned. Documents the
      single model-facing `skill` catalog tool and `/<skillName>` commands,
      which is exactly the first-class-peer contract now codified in Principle
      II.

  Follow-up TODOs: none. RATIFICATION_DATE set to initial adoption date.
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
  prep, deploy checks, debugging rituals, team checklists) MUST be added as a
  user-created skill, NOT as a built-in feature. Growth of the native toolset
  MUST be justified, not incidental.
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

### III. Bounded Work, Not Just Bounded Output

Every collector and reader MUST cap the work it *performs*, not merely the text
it returns.

- All collection-time and storage-time byte budgets MUST live as named
  constants in `src/core/limits`. Callers MUST cite a constant, never a magic
  number.
- Bash/grep subprocess `stdout`+`stderr`, file reads, `fetch` bodies, LSP
  frames/headers/aggregate buffers, stored tool-output handles, skill files,
  and exact-mutation inputs MUST be bounded before their full content is
  resident in memory.
- Byte limits are byte limits for multibyte UTF-8. Truncation MUST preserve a
  valid UTF-8 prefix (flush the decoder tail only when nothing was omitted from
  that stream).
- Omitted bytes MUST be reported truthfully (`retainedBytes`/`omittedBytes`).
  Raw output MAY remain retrievable behind bounded in-memory handles with
  per-entry and aggregate LRU budgets — never unbounded.

Rationale: a single runaway process, file, or server response MUST NOT be able
to exhaust memory or stall a turn.

### IV. Strong Real-Path Boundaries and Network Safety

The agent runs with the user's privileges; boundaries MUST prevent accidental
exfiltration, traversal, and local-network reach.

- File tools MUST confine to `process.cwd()` via shared workspace path helpers
  and MUST follow `.gitignore` by default. Ignored paths require an explicit
  override (`allowIgnored`/`includeIgnored`).
- Real-path confinement (`assertRealPathInsideRoot`/`assertPathInsideRoot`)
  MUST be reused across file tools, skills, LSP, and the skill registry so
  symlink escapes are rejected.
- The `fetch` tool MUST allow only public `http(s)`, blocking private,
  loopback, link-local, multicast, unspecified, and cloud-metadata hosts, and
  MUST re-validate the public IP after DNS resolution and at every redirect
  hop.
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

**Version**: 1.1.0 | **Ratified**: 2026-07-25 | **Last Amended**: 2026-07-25
