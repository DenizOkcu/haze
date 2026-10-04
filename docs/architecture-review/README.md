# Architecture Review — haze (2026-10-04)

Full-codebase review of `src/` (199 TS/TSX files, ~27.8k lines) by a senior-architect pass with a KISS/DRY/YAGNI bias. Companion documents:

- [`01-core-llm-config-skills.md`](01-core-llm-config-skills.md) — `core/`, `llm/`, `config/`, `skills/`, `utils/`
- [`02-cli-ui.md`](02-cli-ui.md) — `cli/`, `ui/`

## Overall verdict

**Sound, actively maintained architecture.** The layering rules in `src/AGENTS.md` are real and enforced: no imports from `core/`/`llm/` up into `cli/`/`ui/`; the >900-line review rule has zero violations (largest file: `chat.tsx` at 875). Per-directory `AGENTS.md` contracts are an unusual and effective strength — they encode decisions that would otherwise live only in heads.

The weaknesses are concentration risks, not structural rot: a few modules carry disproportionate change blast radius, a handful of sanctioned-but-inverted layer dependencies, and some low-grade duplication in `chat.tsx`.

## Top findings (ranked)

1. **`llm/tools/toolContext.ts` is the highest-fan-in module** (13 importers across 3 layers) and mixes schema, dedup runner, scoped-context discovery, and mutation-stop logic. Highest-priority split candidate.
2. **`core/subagent/subagentRunner.ts` gives `core` a runtime dependency on `llm`** (hazeTools, toolContext, systemPrompt, workerContext), breaking the "core is provider-agnostic" story more than the type-only leaks elsewhere. Consider relocating it to `llm/` or inverting via injection.
3. **`llm/hazeTools.ts` split stopped halfway** — the tool catalog plus several inline tool implementations (509 lines) coexist with a `llm/tools/` directory that was created for exactly this.
4. **`cli/commands/chat.tsx` (875 lines) is the next split** — under the 900 limit but packing ~20 refs + ~15 states, wizard dispatch, session lifecycle, and goal-run plumbing into one component. The business policies inside it (attachment gating, recovery-command classification, resume-kind selection) belong in pure helpers.
5. **Completion-evidence policy triad** (`core/agent/workState.ts` 528, `completionController.ts` 485, `budgets.ts`) is pure and tested but is a single-file-per-concern change hotspot with heavy mirrored prose in `core/agent/AGENTS.md` — doc-drift risk is real.
6. **Provider-capability plumbing is speculative (YAGNI)** — a capabilities object, `core/subagent/contracts` re-export, and per-provider inference exist to serve one boolean (`images`). Sanctioned extension point, but revisit when a second capability lands.
7. **Duplication in `chat.tsx`**: identical reasoning-override setter logic twice, signature-map building twice, stacked duplicate JSDoc; wizard suggestion-builders in `wizardFlow.ts` share one skeleton ×3.
8. **Error regimes are three-tiered** (throw for settings/providers, structured results for tools, swallowed assertions in `config/contextFiles.ts:85`) — defensible, but the `.catch(() => undefined)` swallow is the least consistent spot.

## Non-issues verified

- `src/cli/contextReport.ts` is **not** dead code — it is the `npm run context:report` entrypoint (`package.json:44`), distinct from `src/cli/chat/contextReport.ts`.
- `ui/` is clean: prop-driven components, no settings/session imports.
- `streaming.ts` is a genuinely thin 282-line facade over 20 well-scoped siblings.

## Recommended sequence (smallest-change-first)

1. Extract duplicated helpers in `chat.tsx` (mechanical, zero UX change).
2. Finish the `hazeTools.ts` → `llm/tools/*` extraction.
3. Decide `subagentRunner`'s home layer (relocation or dependency injection).
4. Split `toolContext.ts` into schema vs. runtime concerns.
5. Extract a single pure provider/model/reasoning resolver so the documented precedence chain is testable in one place.
