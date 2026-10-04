# Review: `cli/`, `ui/`

## 1. UI / business-logic boundary

Broadly respected: `ui/components/*` are prop-driven with no settings/session imports, and durable state consistently lives in `config/`/`core/` modules. Exceptions:

- **`src/cli/commands/chat.tsx`** — testable business policies live inside the React component:
  - `prepareUserInput` image-attachment gating policy (lines 533–555)
  - recovery-command classification regex in `submit` (line 443)
  - paused-goal resume-kind selection (lines 589–598)
  - session-model-selection patch policy (lines 100–114)
- **`src/cli/commands/wizardFlow.ts`** (517 lines) — mixes vocabulary constants, pure validation/capture, and ~15 per-domain suggestion-builders; the de-facto dumping ground for wizard logic. Pure, but busy.
- **`streaming/attemptOutcome.ts`** (330 lines) — a faithful adapter of `core/agent/completionController`, but it re-exports/orchestrates a large slice of policy; the AGENTS.md itself flags it ("do not duplicate status inference elsewhere").

## 2. KISS / DRY / YAGNI findings

1. **Duplicated reasoning-override setter** — `chat.tsx` lines 403–414 (wizard dispatch) and 494–503 (`CommandContext.setSessionReasoning`) are byte-for-byte identical delete-or-spread + counter-bump logic. Extract one helper.
2. **Duplicated context-file signature map** — `chat.tsx` line 259 and 486–487 repeat `new Map(files.flatMap(f => f.signature ? [[f.path, f.signature]] : []))`. One helper in `chat/contextReport.ts`.
3. **Stacked duplicate JSDoc** for `resumePausedTask` (`chat.tsx` lines 577–588) — editing artifact; delete one.
4. **Wizard suggestion-builders** — `lspActionSuggestions` / `mcpActionSuggestions` / `skillsActionSuggestions` (`wizardFlow.ts:294–378`) share one enable/disable/remove skeleton; three near-identical `capture*Name` functions (132–151). A shared "entity action suggestions" helper would shrink the file meaningfully.
5. **Two `contextReport.ts` files** — `src/cli/contextReport.ts` and `src/cli/chat/contextReport.ts`. Verified: the root one is the `npm run context:report` CLI entrypoint (`package.json:44`), **not** dead code — but the name collision invites confusion. Rename or merge behind a shared helper.

## 3. Oversized files (>900 lines)

**None.** Largest: `chat.tsx` 875, `streamLoop.ts` 553, `wizardFlow.ts` 517, `MarkdownText.tsx` 498, `TextInput.tsx` 444. `chat.tsx` is within the limit but is the clear next split candidate — ~15 refs + states, wizard dispatch, session lifecycle wiring, goal-run plumbing, and render in one component. Extracting goal-run plumbing (`runSingleAgentTurn`/`resumePausedTask`) into `chat/turnRunner.ts` would give comfortable headroom.

## 4. State-management complexity hotspots

- **ChatScreen (`chat.tsx`)** — the biggest hotspot: ~20 refs + ~15 states + one reducer. Notable patterns: dual state/ref mirroring for settings with a bespoke selection-preservation patch (97–118); a `reasoningOverrideCounter` state used only to force re-render; `pausedResume` carrying a 5-field union; `createWizardDispatch`/`createSessionLifecycle` rebuilt every render. Works, but every feature adds another ref+state pair.
- **`streaming/` stack** — well-factored facade + 20 siblings, but a single turn's state spans 4 layers (`goalSupervisor` → `streaming.ts` → `agentAttempt` → `streamLoop` sharing `AttemptLoopState`), plus quarantine/ledger sinks wired in `chat.tsx`. The AGENTS.md contracts mitigate this; onboarding cost is still high.
- **`wizard/uiState.ts` reducer** — a good consolidation (replaced 12 `useState` hooks).

## 5. Strengths

- `streaming.ts` is a genuinely thin 282-line facade; the >900 rule is actively enforced across the whole scope.
- `WIZARD_STEPS` table (`wizardFlow.ts:457–505`): adding a wizard step is one row, with `chatModes.ts` deriving mode classification. Textbook table-driven design.
- `ui/components` are prop-only; `WizardChoices.tsx` deliberately avoids a second state machine.
- No durable business state in React state — everything persisted routes through `config/`/`core/`.

## Recommended actions

1. Extract the two duplicated helpers and the stacked JSDoc in `chat.tsx` (mechanical, zero UX change).
2. Move the four embedded policies (attachment gating, recovery-command classification, resume-kind selection, model-selection patch) into pure, tested helpers under `cli/chat/`.
3. Split `chat.tsx` further via a `chat/turnRunner.ts` before the next feature lands there.
4. Generalize the wizard suggestion-builder skeleton in `wizardFlow.ts`.
5. Disambiguate the two `contextReport.ts` modules (rename the CLI entrypoint or merge implementations).
