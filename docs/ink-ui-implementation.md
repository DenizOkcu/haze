# Ink UI adoption — implementation and validation

Date: 2026-10-04. Implements the compatible presentation slice of
[the adoption plan](ink-ui-migration-plan.md); **not a wholesale input replacement**.

## Dependency and compatibility

- Pinned the published `@inkjs/ui` **2.0.0** using npm; only its generated lockfile changes accompany the dependency change.
- Published metadata: ESM, Node >=18, Ink >=5 peer; no Ink/React downgrade or forced peer resolution.
- Audited installed declarations and implementation, not upstream main. Public exports include Select, TextInput, PasswordInput, ConfirmInput and ThemeProvider/extendTheme.
- Real Ink 8.0.0 / React 19.3.0 renderer mounts/unmounts both Select and library TextInput successfully on Node **26.7.0**, npm **12.1.0**.
- **Node 22.23.3 runtime compatibility verified:** the library-backed choice tests, composer integration tests, and real renderer tests all passed (**3 files, 20 tests**). Initial npx/npm-exec attempts resolved the host runtime because npm blocked the node wrapper's install script. Installing the platform binary package `node-bin-darwin-arm64@22.23.3` in a temporary prefix and invoking its executable directly resolved that environment issue without altering project dependencies or the project's install-script policy. A subsequent wrapper install also passed with node's install script approved only in a disposable temporary package manifest; the same Node 22 test run passed again. The package runtime floor remains unchanged.

## Implemented integration

`src/ui/components/WizardChoices.tsx` uses the library's public Select and theme API.
All wizard `kind: 'pick'` rows use it through TextInput's existing `suggestionMode="always"` contract, including themes and reasoning. No changes to submission handlers, settings writes, session identity, discovery, or wizard flow state.

This is **library-backed choice presentation with the existing editor as the sole keyboard owner**, not library-owned navigation. Select 2.0.0 has no controlled focused-value/on-focus-change API, filtering, descriptions, or Tab completion. Its callback fires after selection in an effect; its viewport state does not recompute solely when visibleOptionCount changes. Enabling it alongside haze's editor would create competing Enter/arrow listeners and lose existing completion/free-form semantics.

The small supported composition therefore:

- supplies the already filtered and selected window to a passive (`isDisabled`) Select;
- marks the active stable value via defaultValue, with no library submission callback;
- remounts that view when active identity, window start, or granted row count changes;
- maps selected/unselected colors to the live haze palette and truncates each option to one row;
- preserves kind and description text in labels, separately from submission values;
- renders nothing for empty lists or zero granted choice rows;
- leaves keyboard navigation, filtering, Tab, paste, free-form submission, cancellation and history rules in the single existing editor.

There is no duplicated wizard state machine, private library import, or extra active key listener. The custom suggestion markup remains only for chat slash/path completion. DynamicFrame's existing demand and allocation API is sufficient; no extra unbounded panel was added. Terminal OSC defaults and append-only Static history are untouched.

## Step eligibility audit

Every WIZARD_STEPS row retains its existing placeholder, submission value and empty/default rules. Choices remain suggestions, not newly enforced enums: unmatched text still reaches existing domain validation. Filtering remains case-insensitive value/description matching, capped at the existing 20 results; arrows select a bounded window, Tab completes without submitting, and Enter submits the highlighted suggestion or unmatched draft once.

| Classification | Step IDs | Outcome |
| --- | --- | --- |
| Session choices | sessions, sessionAction | Library choice view; exact session submission values retained. |
| Provider/model choices | provider, providerAction, providerAddPreset, model, modelAddProvider, modelPick | Library choice view; manual model-name action, discovery/loading/error paths and explicit selection unchanged. |
| Skill choices | skills, skillsAction, skillsAddScope | Library choice view; project/global provenance and stable disambiguated values retained. |
| LSP choices | lsp, lspAction, lspAddPreset | Library choice view; custom-server escape path retained. |
| MCP choices | mcp, mcpAction, mcpAddPreset, mcpAddTransport | Library choice view; custom-server/transport validation retained. |
| Theme/reasoning choices | themes, reasoning | Library choice view; direct slash-command arguments still use existing handlers. |
| Free-form provider fields | providerAddName, providerAddUrl, providerAddModels, providerAppendModels, providerRemoveModels | Custom editor retained. |
| Free-form skill fields | skillsAddName, skillsAddDescription | Custom editor retained, including multiline descriptions. |
| Free-form server fields | lspAddName, lspAddCommand, mcpAddName, mcpAddUrl, mcpAddCommand | Custom editor retained. |
| Masked fields | providerAddKey, providerSetKey, mcpAddKey, mcpSetKey | Custom masked editor retained; add-key steps allow empty, set-key steps do not. |
| Typed confirmations | providerConfirmRemove, skillsConfirmRemove, lspConfirmRemove, mcpConfirmRemove | Custom editor retained; literal `yes` semantics unchanged. |

TextInput and PasswordInput are **not eligible for direct substitution** in this release: their hooks own useInput but not Ink 8 usePaste; they lack haze's grapheme/cell-width handling, modified-Enter multiline behavior, control-key editing, and explicit row-demand contract. Adapting all of those would duplicate the editor rather than reduce it. Masked values continue using the tested no-history custom path. No credentials are used in the compatibility probes.

ConfirmInput would change typed confirmation to immediate Y/n semantics, so it is intentionally not adopted. MultiSelect has no equivalent existing flow. The optional spinner follow-up is not included; ink-spinner is still used and retained. The multiline chat composer and application-specific transcript/header/task/frame components remain custom by design.

## Validation evidence

- Pre-change typecheck and focused wizard/renderer/composer/theme baseline: **15 files, 113 tests passed**.
- Themes pilot typecheck and focused renderer/input checks passed before extending the shared choice view.
- Provider/session/skill/LSP/MCP domain and choice-view checks: **7 files, 59 tests passed**.
- Added **10** library-backed tests covering published-component mount/unmount, filtering and Tab, single submit, Escape, task toggle, no history, stable skill identity, arrows, reopening, return to multiline chat, disabled paste, Ctrl+C, unmatched manual values, zero/empty lists, active-window resizing, palette mapping, and whole-frame dimensions down to **1×1**.
- `npm run typecheck && npm test && npm run lint && npm run build && npm pack --dry-run`: **passed**. Full suite: **172 files / 2009 tests passed; 7 files / 8 tests skipped** under existing conditional gates.
- Existing real-renderer tests exercise actual terminal byte events and Static-history writes; they do not prove emulator behavior. No manual terminal smoke test, Windows/Linux terminal run, or enhanced-keyboard emulator interaction was performed. These remain release-confidence coverage gaps, not claims of verified support.

No version bump, publication, headless change, agent-runtime change, or credential-file access is part of this slice.
