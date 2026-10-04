# Ink UI adoption plan

Date: 2026-10-04.
Status: compatible choice-presentation slice implemented; library-owned input/navigation deferred at the behavior gates. See [implementation and validation](ink-ui-implementation.md) for adopted flows, retained controls, and runtime coverage gaps.
Target library: [`@inkjs/ui`](https://github.com/vadimdemedes/ink-ui), not `inkjs/ui` as an import path.

## Goal and approach

Use Ink UI's ready-made components for standard interactive controls, reducing custom presentation and keyboard handling without replacing haze's terminal architecture or changing durable behavior.

Adopt incrementally: compatibility probe → themed integration → theme-picker pilot → remaining compatible wizard controls → validation and cleanup. Keep the chat composer custom. Do not introduce a generic form framework or force every UI surface through Ink UI.

## Current state and upstream evidence

- `package.json` pins Ink 8.0.0 and React 19.3.0; haze supports Node >=22 and ESM. `@inkjs/ui` is not currently a dependency.
- `src/cli/commands/wizardFlow.ts` is the authoritative step table, including suggestions, capture functions, optional submission, and picker/masked classifications. `chatModes.ts` derives modes; `chat/wizardDispatch.ts` and `chat/wizard/*Handlers.ts` own submission effects.
- `src/ui/components/TextInput.tsx` currently serves both chat and wizard input. It supports multiline editing, history, masked input, slash and path suggestions, native paste, cursor geometry, row-demand reporting, and global shortcuts. Ink UI's documented TextInput is single-line, so it is not a drop-in replacement.
- `src/cli/chat/DynamicFrame.tsx` allocates and clips the full dynamic tail, including input and suggestion rows. Library controls must participate in that budget rather than simply render an unrestricted list.
- The shared palette/resolver is `src/ui/theme.ts`; terminal defaults are separately managed by `terminalColors.ts`. Historical Static output intentionally retains its previous colors.
- Upstream README inspected during planning documents TextInput, PasswordInput, ConfirmInput, Select, and MultiSelect. Upstream main's package metadata reports version 2.0.0, ESM, Node >=18, and an Ink >=5 peer range. This permits Ink 8 nominally, but does not prove React 19 or runtime compatibility. Main is not evidence of the latest published release: inspect published metadata and exact-version declarations before installation.
- Existing Ink 8 work is documented in `docs/ink-v8-migration-plan.md`; preserve its viewport, input, and transcript contracts.

## Component mapping

| Existing surface | Candidate | Decision |
| --- | --- | --- |
| `/themes` closed-choice picker | Select | First integration pilot; preserve stable values and live theme application. |
| Provider, model, session, skill, LSP, and MCP closed-choice steps | Select | Migrate only when descriptions, filtering, stable identity, and free-form escape paths remain equivalent. |
| Ordinary single-line wizard fields | TextInput | Migrate after paste, submit, cancellation, optional-empty, and width tests pass. |
| API-key wizard fields | PasswordInput | Migrate only after proving masking, no-history, no-log, and disabled-paste safety. Use synthetic credentials in tests. |
| Existing confirmation steps | ConfirmInput | Conditional: keep current explicit confirmation/default semantics; no change from typed confirmation to immediate Y/n without an explicit UX decision. |
| Multi-item choices | MultiSelect | Deferred unless an existing flow has matching semantics; do not add bulk actions merely to use this component. |
| Busy indicator | Library spinner, if suitable in selected release | Optional follow-up; preserve timing, text, colors, and row count. Remove ink-spinner only if all uses are replaced. |
| Multiline chat composer, slash and `@path` completion | Existing custom TextInput | Retain. Ink UI's single-line input is insufficient for current contracts. |
| Markdown transcript, Header, TaskBar, Static history, DynamicFrame | Existing Ink/custom components | Retain; these are application-specific, not standard form controls. |

## Implementation slices

### UI01 — Compatibility and behavior audit

1. Capture worktree status, Node/npm versions, dependency tree, and baseline focused test/typecheck results before changing anything.
2. Inspect the exact published candidate's peer dependencies, exports, TypeScript declarations, theming API, input activation behavior, Select viewport/search capabilities, and submission callback semantics.
3. Inventory each `WIZARD_STEPS` row as closed-choice, searchable choice, free-form field, masked field, or confirmation. Record required keyboard/default behavior and whether arbitrary values are currently accepted.
4. Install and pin a compatible release with npm, updating `package.json` and the npm-generated lockfile only. Do not downgrade Ink/React or use forced peer resolution to bypass incompatibility.
5. Add a small real-renderer smoke test using the repository's renderer-test patterns: mount/unmount a candidate input and Select under Ink 8/React 19.

Acceptance: dependency/type/runtime compatibility demonstrated on Node 22; per-step eligibility recorded. If incompatible, report the exact issue and retain existing controls rather than silently changing runtime dependencies.

### UI02 — Minimal theme, focus, and layout integration

1. Use the selected release's documented theme mechanism to map haze palette tokens; verify the concrete API before writing the integration. Place reusable presentation glue under `src/ui/`, not settings-aware library wrappers.
2. Update the library theme when haze's theme changes. Keep OSC 10/11 handling and Static history behavior unchanged.
3. Extend the DynamicFrame input contract only as needed to support choice-list row demand. Bound visible choices by granted rows, include hints/descriptions in demand, and handle a zero-choice-row or tiny viewport safely. Keep the active selection visible after resize.
4. Ensure only the active control owns text/navigation input. Preserve terminal-wide Ctrl+C even while disabled, Escape/cancel, Ctrl+O task toggling, and paused-turn R behavior in their appropriate modes. Avoid two simultaneous keyboard listeners submitting or editing the same event.
5. Use direct library components where possible; add thin adapters only for repeated theme, callback, or row-budget translation. No duplicated wizard state machine.

Acceptance: themed components fit within the entire frame at narrow/short sizes, respond to live theme changes, and submit once per event. No alternate-screen conversion or unbounded dynamic output.

### UI03 — `/themes` pilot

1. Render the existing theme suggestions as Select options, preserving their submission values and any displayed descriptions.
2. Connect selection to the existing wizard submission path; keep validation, persistence, and live application in existing handlers.
3. Preserve `/themes <name>` and Escape/cancel behavior. Check current type-to-filter and Tab behavior: implement equivalent behavior through supported composition, or retain the custom control if equivalence cannot be achieved without reimplementing a picker.
4. Add integration tests for navigation, submission, cancellation, empty lists, resizing, theme changes, and reopening the picker.

Acceptance: `/themes` uses a real Ink UI control end-to-end with no duplicate submit or behavior regressions. This pilot must pass before widening adoption.

### UI04 — Eligible wizard controls

1. Migrate closed-choice steps by family: provider/model, session, skills, then LSP/MCP. Keep labels separate from stable values; preserve skill provenance and session identity even when labels collide.
2. Preserve model-discovery loading/error/manual-entry paths, searchable long lists, descriptions, and existing optional/free-form entry paths. Do not silently select the first configured provider/model.
3. Migrate eligible ordinary fields to TextInput, preserving validation, empty-submit rules, paste, remount/reset behavior, and Escape.
4. Migrate masked fields to PasswordInput only after dedicated safety tests pass. Never persist their values in input history, transcript, logs, snapshots, or test failures.
5. Leave confirmation semantics unchanged unless a separately approved UX change allows ConfirmInput. Keep custom controls for non-equivalent flows and document the specific reason.

Acceptance: each migrated family has passing focused tests before starting the next; settings/session mutations remain in existing domain handlers. The chat composer remains custom and continues to work after leaving a wizard.

### UI05 — Cleanup, documentation, and release confidence

1. Remove only custom wizard-specific rendering/keyboard code made unused by migration. Retain inputBuffer, textGeometry, useInputSuggestions, and chat-composer behavior.
2. Document which flows use library controls, retained exceptions, and any explicitly approved keyboard changes. Update help and user docs only where visible behavior changes.
3. Run full source and package checks; record runtime/terminal coverage and failures honestly. Do not publish or change the release version as part of adoption.

Acceptance: less custom control code, no parallel wizard flow implementation, all required regression gates green, and no unresolved safety/layout regressions.

## Validation plan

Run focused tests with each slice, not just after the final migration:

- Wizard contracts: `tests/cli/wizardInput.test.ts`, `wizardActions.test.ts`, `wizardPrompts.test.ts`, `wizardSuggestions.test.ts`, and `chatModes.test.ts`.
- Domain behavior: provider, session, skill, LSP, and MCP wizard suites under `tests/cli/`.
- Renderer/layout: `tests/cli/inkRenderer.test.tsx`, `liveRegion.test.ts`, `messages.test.tsx`, and applicable frame tests under `tests/cli/chat/`.
- Composer/theme regression: applicable `tests/ui/` tests, especially input buffer, text geometry, theme, and terminal colors.
- Add library-backed integration tests with ink-testing-library or the existing real-renderer harness, covering actual key events instead of mocking the new components away.

Required edge cases: Enter submits once; Escape cancels; Tab/arrows and filtering retain their existing contract; default/empty confirmation is safe; optional-empty fields work; disabled controls discard paste; multiline pasted input cannot trigger unintended submissions; masked data never enters history/logs; mode transitions reset only the intended draft; duplicate labels remain distinguishable; long lists and descriptions fit their allocation; resizing does not wipe scrollback; Ctrl+C still interrupts; returning to chat restores multiline editing, history, path completion, modified Enter, task toggle, and paused-goal resume.

Before completion:

```sh
npm run typecheck && npm test && npm run lint && npm run build
npm pack --dry-run
```

Manually smoke-test Node 22, narrow/short terminals, large pickers, Unicode labels, paste, theme switching, streaming plus a busy indicator, and exit/cancel in supported terminal environments. Record untested platforms explicitly. Automated snapshots alone do not prove terminal scrollback or keyboard-protocol correctness.

## Scope boundaries and decision gates

No changes to agent execution, provider adapters, session format, durable settings semantics, headless output, Markdown streaming, secret-file protection, or alternate-screen behavior. No credential-file reads.

Compatibility is a hard gate. Equivalent input behavior and bounded rendering are hard gates. If a component cannot meet a required contract through a small supported integration, retain the existing implementation and record the limitation. Intentional UX changes require a separate decision; they are not incidental cleanup.

Suggested delivery: PR 1 = UI01–UI03; PR 2 = eligible UI04 families plus UI05. Expand only after the pilot proves the integration.
