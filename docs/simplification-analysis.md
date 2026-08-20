# Haze Codebase Simplification Analysis

Generated: 2026-08-19
Total source: ~23,445 lines across 150+ files

> **Implementation status (2026-08-19, same day):** the P0 and P1 items and the
> two concrete P2 extractions are implemented; the remaining P2 items were
> evaluated and deliberately declined. See [Implementation log](#implementation-log)
> at the end of this document for outcomes, decisions, and validation.

## Priority Framework

| Priority | Criteria |
|----------|----------|
| **P0 - Quick Wins** | Low risk, high readability gain, pure/data-heavy, well-tested |
| **P1 - Medium Effort** | Moderate risk, needs careful refactoring, some shared usage |
| **P2 - Core Refactors** | High risk, deeply shared, changing behavior requires full regression |

---

## P0 — Quick Wins (Low Risk, High Impact)

### 1. Theme Registry (`src/ui/themes/`)
**Size:** 13 files, ~500-800 lines total (estimated ~50 lines each)
**Risk:** Low — pure color mappings, well-isolated

**Current state:** 13 separate theme files (`af-magic.ts`, `agnoster.ts`, `bira.ts`, `bureau.ts`, `clean.ts`, `cloud.ts`, `dst.ts`, `fishy.ts`, `light.ts`, `purple.ts`, `robbyrussell.ts`, `solarized-dark.ts`, `solarized-light.ts`, `steeef.ts`) each exporting a palette object, plus `index.ts` that registers them.

**Simplification:** Consolidate into a single `themes/registry.ts` containing a `THEMES` map keyed by name. Each theme becomes a data object rather than a file. The `resolveTheme` validation and `index.ts` imports become trivial.

**Estimated reduction:** ~30-40% in file count, ~20% in total lines.

---

### 2. Provider Presets (`src/config/providerPresets.ts`)
**Size:** 772 lines
**Risk:** Low-Medium — UI-facing, but pure data + simple config generation

**Current state:** Contains hardcoded provider configuration presets (UI presets for provider setup). Much of this is repetitive provider boilerplate — endpoint URLs, auth type definitions, model list stubs.

**Simplification:**
- Extract common provider schema into a reusable definition type.
- Reduce each preset entry to name + endpoint + auth type (3-4 fields) instead of full config objects.
- Consider loading popular presets from a small embedded JSON rather than TS code.

**Estimated reduction:** ~40-50% lines (potentially to ~400 lines).

---

### 3. Formatters (`src/cli/commands/formatters.ts`)
**Size:** 350 lines
**Risk:** Low — pure formatting functions, well-tested

**Current state:** Formatting utilities for token counts, time, session summaries, tool captions, etc. Many are single-line functions.

**Simplification:**
- Move simple formatters (`formatTokenCount`, `formatSeconds`, `formatIdleMinutes`, `formatElapsedTimeWhole`) to `src/utils/format.ts` (which exists but is empty/minimal).
- Reduce `formatters.ts` to only complex UI-specific formatting (tool captions, session display).

**Estimated reduction:** ~25% lines, better module cohesion.

---

### 4. Skills Builder (`src/skills/builder/SkillBuilder.ts`)
**Size:** Read file for exact count (likely <200 lines)
**Risk:** Low — deterministic fallback content, model-optional

**Current state:** Creates skills from name + description. When no model is configured, generates deterministic fallback content.

**Simplification:** The builder is already small. The main simplification is making the fallback content generation more declarative (template strings) rather than procedural.

---

## P1 — Medium Effort (Moderate Risk)

### 5. MarkdownText Component (`src/ui/components/MarkdownText.tsx`)
**Size:** 497 lines
**Risk:** Medium — UI-visible, streaming-dependent

**Current state:** Full Markdown renderer for terminal constraints. Handles headings, lists, code fences, tables, emphasis, links, inline code, horizontal rules, and width-aware rendering.

**Simplification:**
- Replace custom Markdown parsing with a lightweight terminal-aware Markdown library (e.g., `marked` + custom renderer, or `remark` + `rehype-stringify` with terminal adapters).
- Keep streaming-safe root committing logic but delegate parsing.

**Estimated reduction:** ~30-40% lines, but adds a dependency. Evaluate tradeoff.

---

### 6. TextInput Component (`src/ui/components/TextInput.tsx`)
**Size:** 384 lines
**Risk:** Medium — core interaction, heavily tested

**Current state:** Terminal text editing with cursor-aware slash/`@path` suggestions, keyboard handling (Tab, arrow, Enter completion).

**Simplification:**
- Extract the suggestion engine (`inputSuggestionsForState` from `chat/inputSuggestions.ts`) into a standalone hook/component.
- Simplify the cursor-aware editing into a smaller core with composable suggestion layers.

**Estimated reduction:** ~20-25% lines.

---

### 7. Messages Component (`src/cli/chat/messages.tsx`)
**Size:** 351 lines
**Risk:** Medium — display ordering, streaming promotion

**Current state:** Ordered static/dynamic transcript partitioning and message views. Manages streaming promotion, message grouping, and the static/dynamic boundary for Ink `<Static>`.

**Simplification:**
- Extract the partitioning algorithm (`partitionDisplayMessages`) into a pure utility in `core/` or `utils/`.
- Reduce the component to rendering logic.

**Estimated reduction:** ~25% lines.

---

### 8. Chat Screen (`src/cli/commands/chat.tsx`)
**Size:** 839 lines
**Risk:** Medium-High — the main interactive screen, many concerns

**Current state:** The most complex single file. Manages:
- Mode/picker state
- Input history
- Context refresh/signature tracking
- Tasks display
- Token display
- Abort handling
- Debug logging
- Session lifecycle
- Wizard dispatch
- Theme switching
- Busy indicator with heartbeat
- Follow-up queue
- Skills loading
- Branch name polling
- Update checking
- Startup info display
- Runtime diagnostics

**Simplification:**
- Extract `busyIndicator` and `heartbeat` logic into its own component (already partially done with `BusyBar`).
- Extract `startupSequence` (settings, context, session init, skills, update check, diagnostics) into a pure async function.
- Extract `followUpQueue` management into a dedicated module.
- The session lifecycle and wizard dispatch are already extracted — good.

**Estimated reduction:** ~30% lines (to ~580), but requires careful testing.

---

### 9. Wizard Dispatch (`src/cli/chat/wizardDispatch.ts`)
**Size:** 937 lines
**Risk:** Medium — complex reducer with many modes

**Current state:** The single largest file. Handles wizard submit engine: per-mode handlers, field-transition effects, and the `WizardUiState` reducer that owns selection/drafts/model-discovery state. Replaced "twelve individual useState hooks" with one reducer.

**Simplification:**
- Split the reducer into mode-specific sub-reducers (provider wizard, model picker, skills picker, etc.).
- Extract field-transition effects into separate handlers.
- The `WIZARD_STEPS` table (from `wizardFlow.ts`) is the source of truth — ensure the reducer mirrors it directly rather than having parallel logic.

**Estimated reduction:** ~30-40% lines, but the logic density increases per file.

---

## P2 — Core Refactors (High Risk)

### 10. Stream Loop (`src/cli/commands/streaming/streamLoop.ts`)
**Size:** 524 lines
**Risk:** High — the core agent loop, driving ToolLoopAgent

**Current state:** Drives the AI SDK `ToolLoopAgent` loop with:
- Repair/prepareStep/step observers
- Public stream-part application (assistant segments, tool groups, goal events)
- Post-stream conversation commit
- Malformed tool recovery
- Assistant text filtering and display
- Tool result state tracking
- Duplicate detection

**Simplification:**
- Extract assistant text handling into its own module (already partially done in `assistantText.ts`).
- Extract tool result handling into a dedicated handler.
- The `prepareStep` function (lines 150-214) is a 65-line decision tree that could be a state machine.

**Estimated reduction:** ~20% lines.

---

### 11. Completion Controller (`src/core/agent/completionController.ts`)
**Size:** 428 lines
**Risk:** High — pure policy but authoritative for turn completion

**Current state:** Pure, unit-testable turn-completion decision logic:
- `decideTerminalStatus`
- `assessCompletionReadiness` (8 states)
- `classifyTerminalOutcome`
- `decideGoalContinuation`
- `decideLengthRecovery`
- `decideRescue`
- `isBudgetExhausted`
- `TurnExecutionState`

**Simplification:**
- The 8 readiness states are well-defined but the decision trees are dense.
- Could extract each readiness case into a small named function with a clear return value.
- The `classifyTerminalOutcome` function (terminal classification) could be a rule table.

**Estimated reduction:** ~15-20% lines.

---

### 12. Work State (`src/core/agent/workState.ts`)
**Size:** 337 lines
**Risk:** High — shared by compaction, session snapshots, CLI, streaming

**Current state:** Structured work state for compaction/session snapshots:
- Mutation/validation sequence tracking
- `deriveValidationOutcome` (passed/failed/stale/absent/not_applicable)
- Task progress tracking
- Goal evidence seeding across physical turns

**Simplification:**
- Some of the sequence-tracking logic could be expressed as a small state machine.
- The validation outcome derivation is dense but well-tested.

**Estimated reduction:** ~15% lines.

---

### 13. Haze Tools (`src/llm/hazeTools.ts`)
**Size:** 489 lines
**Risk:** High — the public tool catalog

**Current state:** Defines the public built-in tool catalog and schemas for all tools (file operations, shell, grep, fetch, LSP, MCP, subagent, tasks, etc.).

**Simplification:**
- The tool definitions are repetitive (each tool needs name, description, schema, execute).
- Could use a tool-definition DSL or factory function to reduce boilerplate.
- The tool descriptions are verbose — could move to a separate descriptions file.

**Estimated reduction:** ~20% lines.

---

### 14. Tool Context (`src/llm/tools/toolContext.ts`)
**Size:** 280 lines (14293 bytes)
**Risk:** Medium-High — per-turn execution state

**Current state:** Per-turn execution state on AI SDK tool `context` values:
- Deduplication of read-only and mutating calls
- Concurrent mutation prevention
- Edit recovery tracking
- Scoped context file discovery
- Workspace mutation policy

**Simplification:**
- The deduplication logic could use a simpler cache structure.
- Some of the concurrent mutation tracking is defensive — could be simplified if the contract is tighter.

**Estimated reduction:** ~15% lines.

---

### 15. Streaming Orchestrator (`src/cli/commands/streaming.ts`)
**Size:** 246 lines
**Risk:** Medium — turn facade, the public API

**Current state:** Thin turn facade (`runAgentTurn` + turn types) that manages:
- Abort controller lifecycle
- Budget management (turn-wide and slice)
- Goal creation and evidence seeding
- Retry loop (idle stalls, context overflow, transient errors)
- Recovery slice handling
- Forced settlement

**Simplification:**
- The retry/recovery `while(true)` loop (lines 165-234) is dense but clear.
- Could extract the recovery slice handling into a dedicated handler.

**Estimated reduction:** ~15% lines.

---

## Summary Table

| Priority | Component | Lines | Risk | Est. Reduction |
|----------|-----------|-------|------|----------------|
| P0 | Theme registry | ~650 (13 files) | Low | 30-40% (file count) |
| P0 | Provider presets | 772 | Low-Med | 40-50% |
| P0 | Formatters | 350 | Low | 25% |
| P0 | Skills builder | ~150 | Low | 15% |
| P1 | MarkdownText | 497 | Medium | 30-40% |
| P1 | TextInput | 384 | Medium | 20-25% |
| P1 | Messages | 351 | Medium | 25% |
| P1 | Chat screen | 839 | Med-High | 30% |
| P1 | Wizard dispatch | 937 | Medium | 30-40% |
| P2 | Stream loop | 524 | High | 20% |
| P2 | Completion ctrl | 428 | High | 15-20% |
| P2 | Work state | 337 | High | 15% |
| P2 | Haze tools | 489 | High | 20% |
| P2 | Tool context | 280 | Med-High | 15% |
| P2 | Streaming | 246 | Medium | 15% |

## Recommended Order

1. **P0-1: Themes** — Delete 12 files, keep one registry. 5 minutes.
2. **P0-2: Formatters** — Move simple formatters to `utils/format.ts`. 10 minutes.
3. **P0-3: Provider presets** — Extract common schema, reduce boilerplate. 30 minutes.
4. **P1-3: Messages** — Extract partitioning to pure utility. 30 minutes.
5. **P1-4: Chat screen** — Extract startup sequence and follow-up queue. 1 hour.
6. **P1-5: Wizard dispatch** — Split into sub-reducers. 2 hours.
7. **P1-1: MarkdownText** — Evaluate library vs custom rewrite. 2 hours.
8. **P1-2: TextInput** — Extract suggestion engine. 1 hour.
9. Remaining P2 items require full regression testing after each change.

## Total Potential Reduction

Rough estimate: ~3,500-4,500 lines removed across the codebase (15-20% total), with P0 items being nearly free and P2 items requiring careful regression.

---

## Implementation log

Implemented 2026-08-19. Every phase was validated with `npm run typecheck &&
npm test && npm run lint` and the final state additionally with `npm run build`
and `npm pack --dry-run` (1683 tests green throughout; no behavior change was
intended anywhere — public APIs and test contracts were kept stable except
where noted).

### Implemented

| Item | Outcome |
|------|---------|
| P0-1 Themes | 15 theme TS files (14 themes + `index.ts`) consolidated into one `src/ui/themes/registry.ts` (`THEMES` map + `BASE_THEME_SPEC`); `theme.ts` imports it directly; `tests/ui/theme.test.ts` now pins registry keys and forbids per-theme files drifting back; `src/ui/themes/AGENTS.md` and root `AGENTS.md` updated. |
| P0-2 Formatters | `formatTokenCount`, `formatSeconds`, `formatIdleMinutes`, `formatElapsedTime(Whole)` moved to `src/utils/format.ts`; `formatters.ts` (350→322) keeps only UI-specific formatting; `chatMetrics.ts` and `stallRecovery.ts` no longer own generic formatters. |
| P0-3 Provider presets | Compact `ProviderPresetDefinition` authoring form: one `[id, contextWindowTokens, maxOutputTokens]` tuple per curated model (was: two entries per model) and `needsApiKey` derived from category/auth. 772→597 lines; exported `PROVIDER_PRESETS` verified byte-equivalent (key-order-insensitive) against a pre-refactor snapshot; embedded-JSON option declined — type-checked TS data beats runtime-parsed JSON. |
| P0-4 Skills builder | No change: the deterministic fallback is already declarative template strings, as the analysis anticipated. |
| P1-3 Messages | `partitionDisplayMessages` + ordering extracted verbatim into pure `src/cli/chat/transcriptPartition.ts`; `messages.tsx` (351→272) is rendering only. |
| P1-4 Chat screen | `chat.tsx` 838→765 via three new focused modules: `chat/startupSequence.ts` (startup banner/session init/skills/update check/diagnostics + branch polling), `chat/followUpQueue.ts` (`useFollowUpQueue`), `chat/busyIndicator.ts` (`useBusyIndicator` heartbeat; BusyBar was already extracted). |
| P1-5 Wizard dispatch | `wizardDispatch.ts` 937→111 composition + re-export point; handler families split into `chat/wizard/` (`providerHandlers`, `skillsHandlers`, `lspHandlers`, `mcpHandlers`, `sessionThemeHandlers`) plus pure `fieldTransitions.ts`, `uiState.ts`, and shared `types.ts` (largest module 440 lines). Tests import from `wizardDispatch.js` unchanged. |
| P1-2 TextInput | Suggestion engine extracted to `ui/components/useInputSuggestions.ts` (slash filtering + async mention completion with cancellation + selection state); `TextInput.tsx` 384→330. `inputSuggestionsForState` already lived in `chat/inputSuggestions.ts`. |
| P2-15 Streaming orchestrator | Recovery-slice admission extracted to `streaming/recoverySlices.ts` (`startRecoverySlice`). |
| P2-10 Stream loop | `streamLoop.ts` 523→295: `prepareStep.ts` (per-step request decision tree incl. repair/prepareStep), `assistantSegments.ts` (segment lifecycle), `toolPartHandlers.ts` (finished tool-call application). |

### Evaluated and declined

| Item | Decision and reason |
|------|----------------------|
| P1-1 MarkdownText | **Keep custom.** Parsing is already delegated to `marked` (`marked.lexer`); the remaining custom code is the Ink terminal renderer and the streaming-safe root chunking (LRU-cached), which no off-the-shelf library provides — `remark`/`rehype` would add heavy dependencies and still require writing the same terminal renderer. The 30–40% estimate does not materialize. |
| P2-11 Completion controller | **Keep.** Already decomposed into small named pure functions (`assessCompletionReadiness` is a 12-line priority chain; `classifyTerminalOutcome` is 9 lines) with a dedicated test file; a rule table or per-case functions would add indirection without measurable reduction. |
| P2-12 Work state | **Keep.** The "sequence tracking" is two monotonic counters snapshotted from `revision`; a state-machine abstraction would wrap 5 lines of arithmetic. `deriveValidationOutcome` is dense but contract-critical and well tested. |
| P2-13 Haze tools | **Keep.** The length is unique per-tool domain logic, not repetitive boilerplate — the shared wrappers (`runDedupedTool`, `structuredToolFailure`, `mutationDiffFields`, `prepareWorkspace*`) are the factory the analysis asks for; a DSL would obscure the AI SDK `tool()` declarations, and the six one-line descriptions do not justify a separate file. |
| P2-14 Tool context | **Keep.** The "cache" is two maps + an epoch (already minimal), and the concurrent-mutation/edit-recovery tracking is a documented runtime contract to preserve, not defensiveness to strip. |

### Notes for future passes

- `chat/wizard/providerHandlers.ts` (~440 lines) is the largest wizard module; if it grows, the model-picker half (`selectModel`/`pickModelToAdd`/add-models flows) is the natural next split.
- The `WizardSetterContext` setter shims earn their keep: removing them would replace one-line setters with verbose `updateWizard({type: 'set', key: ...})` dispatches at ~17 call sites.
- The declined P2 items should only be revisited with a concrete behavior or testability goal, not for line count.

### Follow-up pass (same day)

- **Removed the dead `messages.tsx` re-export shim** for `partitionDisplayMessages`/`TranscriptStaticItem`/`TranscriptStreamingItem`: all importers (including the tests) use `chat/transcriptPartition.js` directly, so `messages.tsx` is now purely the view layer. The `wizardDispatch.ts` re-exports stay — chat.tsx and the wizard tests deliberately import from that single stable surface.
- **Unified settings writes in the wizard handler families.** Every handler module now applies settings patches through the single `ctx.applySettings` helper (which persists via `updateSettings`, propagates via `setSettings`, and returns the persisted settings for callers that render a post-patch banner, e.g. `selectModel`). This replaced eight direct `updateSettings` + `deps.setSettings` pairs scattered across `providerHandlers.ts`, `lspHandlers.ts`, and `mcpHandlers.ts` — previously two idioms coexisted in the same file. Handler modules no longer import `updateSettings` at all; `lspHandlers`' local result type now references `HazeSettings` directly instead of `Parameters<typeof updateSettings>[0]`. The `providerConfirmRemove` IO ordering (settings write before auth removal) is preserved; only the inert React state dispatch moved earlier. Validated with the full suite (1683 tests).
