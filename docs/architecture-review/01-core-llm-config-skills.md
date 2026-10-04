# Review: `core/`, `llm/`, `config/`, `skills/`, `utils/`

## 1. Module boundary violations

Hard UI violations: **none.** Zero imports of `cli/` or `ui/` anywhere in these layers.

Softer layering leaks (mostly sanctioned by per-directory AGENTS.md, but still coupling):

- **`core` → `llm` (runtime)**: `core/subagent/subagentRunner.ts` imports `llm/hazeTools.js`, `llm/tools/toolContext.js`, `llm/systemPrompt.js`, `llm/workerContext.js` (lines 17–21). `core` is not independently testable against the `llm` layer.
- **`llm` → `core/subagent/contracts`**: `llm/client.ts:7` imports `ProviderCapabilities`/`WorkerRuntime` and re-exports them. Provider capability types living under `subagent/` is a misplaced home; `llm` reaching into a domain subtree of core inverts the natural direction.
- **`core` → `config`**: `sessionStore.ts` imports `config/paths` and `config/privateStorage`. Documented, but means `core/session` cannot run with an injected storage root.
- **`skills/builder/SkillBuilder.ts` → `llm/client.js`** — the skills layer couples directly to the model client rather than receiving a model factory.

## 2. KISS / DRY / YAGNI findings (ranked)

1. **`llm/tools/toolContext.ts` is a coupling magnet** — 306 lines, 13 importers across 3 layers (`cli/commands/streaming/*`, `core/subagent/subagentRunner.ts`, `llm/hazeTools.ts`, `lspTools.ts`, 7 tool modules). Holds schema + dedup runner + scoped-context discovery + mutation-stop logic in one module; any signature change ripples repo-wide.
2. **`llm/hazeTools.ts` mixes catalog with implementations** — 508 lines, 30 imports; file/grep/edit/write tool bodies still live inline despite the `llm/tools/` split.
3. **Provider/model resolution precedence is spread** across `config/providers.ts`, `config/modelCatalog.ts`, `core/agent/reasoningPolicy.ts`, and `llm/client.ts` (205 lines pulling from 6 modules). The precedence chain is documented only in AGENTS.md prose; a single pure resolver would make it testable in one place.
4. **`core/agent/workState.ts` (528 lines)** carries mutation/validation seq numbers, red→green command normalization, carried-evidence hydration, compact-profile capsules — a lot of policy state machine in one module. The validation-evidence rules would be a coherent separate module.
5. **`core/agent/completionController.ts` (485 lines)** is a policy god-module: finish-cause normalization, 9-status readiness, terminal classification, budget exhaustion, recovery decisions, and `TurnExecutionState` in one file, with one CLI adapter as the single call site. Pure and testable (a strength) but a change hotspot.
6. **YAGNI — capability plumbing** (`llm/capabilities.ts`, re-export via `core/subagent/contracts`, per-provider inference in `client.ts:47–59`) serves exactly one read key (`images`). KISS would inline until a second capability appears. (AGENTS.md deliberately reserves it as an extension point — speculative but sanctioned.)
7. **DRY — `recoveryTool: 'readFile'` contract** is implemented in `llm/tools/readRecovery.ts`, checked in `core/agent/toolResults.ts`, guarded in `llm/tools/toolContext.ts`, and restated in three AGENTS.md files. The recovery decision could be one function in one module instead of contract-as-documentation.
8. **DRY — skills confinement**: `SkillRegistry.ts:17,30`, `SkillLoader.ts:61,73`, `SkillBuilder.ts:261,264` each hand-roll real-path confinement call sites; a `confinedResolve(root, …)` wrapper would DRY six call sites.
9. **`config/providerPresets.ts` (636 lines) is almost pure data**. Fine as data, but every preset edit touches the largest file in scope; split per-provider if it keeps growing.
10. **Error-handling consistency**: three regimes (loud throw for settings/providers; structured `HazeToolError` results for tools; confinement assertions sometimes swallowed via `.catch(() => undefined)` in `config/contextFiles.ts:85`). The third is the weakest — a silent skip where neighbors report isolation errors.

## 3. Oversized files (>900 lines)

**None.** Largest: `providerPresets.ts` 636, `sessionStore.ts` 617, `workState.ts` 528, `hazeTools.ts` 508, `completionController.ts` 485. The 900-line review rule is clearly enforced (prior splits visible: `llm/tools/*`, `cli/commands/streaming/*`).

## 4. Coupling / risk hotspots

- `llm/tools/toolContext.ts` — highest fan-in in these layers; highest blast radius for change.
- `llm/hazeTools.ts` — second hotspot; imported by both the main request path and the subagent runner.
- `core/subagent/subagentRunner.ts` — the module that most blurs "core is provider/UI-agnostic".
- `workState.ts` + `completionController.ts` + `budgets.ts` — the completion-evidence policy triad: every behavior tweak touches this cluster **and** its mirrored prose in `core/agent/AGENTS.md` (~15 distinct numeric/policy contracts). Doc-drift risk is real; prefer deriving docs from code or generating invariant tables.
- `core/limits.ts` — central constant hub imported everywhere; deliberate and low-risk, but a single accidental edit has broad blast radius.

## 5. Strengths

- Strict one-way layering with zero UI leakage; effects (fs/network/process/terminal) well isolated behind small modules.
- The `llm/tools/` and `cli/commands/streaming/` splits show the size rule is actively applied, not aspirational.
- Structured tool failure results (`llm/tools/failures.ts`) give the model actionable retry semantics — better than most agent codebases.
- Per-directory AGENTS.md contracts materially lower onboarding cost in the complex streaming stack.
- `utils/` is genuinely small and free of policy.

## Recommended actions

1. Split `toolContext.ts` (schema vs. runtime) before it grows further.
2. Finish the `hazeTools.ts` extraction into `llm/tools/`.
3. Relocate `subagentRunner` to `llm/` (or inject its `llm` dependencies) so `core` stays provider-agnostic.
4. Extract one pure `resolveAttemptModel(provider, model, reasoning, …)` covering the documented precedence chain; unit-test it end to end.
5. Replace the `contextFiles.ts` swallow with a reported isolation error (or at minimum a debug log).
6. Add a `confinedResolve` helper in `skills/` and collapse the six hand-rolled call sites.
