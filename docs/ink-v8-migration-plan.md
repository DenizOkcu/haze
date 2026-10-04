# Ink v8 migration: agent implementation plan

Date: 2026-10-04. Target: pinned Ink 8.0.0 from haze's Ink 7.1.1.
Status: **required code slices implemented**. See [implementation evidence](ink-v8-implementation.md)
for checks, deviations, and remaining Node 22/emulator coverage gaps. M09 remains deferred;
no publishing or alternate-screen/concurrency experiment was performed.

Companions: [analysis](ink-v8-analysis.md), [validation matrix](ink-v8-validation.md).
Read root and scoped AGENTS.md before touching source/tests. The analysis distinguishes
upstream facts, confirmed local shortcomings, and runtime risks not yet reproduced.

## Scope and invariants

Compatibility deliverable: install Ink 8, retain existing UX, demonstrate supported
runtime/dependency compatibility and terminal regressions. Modernization deliverable:
complete required follow-ups below; do not call a dependency-only PR modernization.

Preserve:

- Normal screen and append-only Static transcript; no alternate-screen default.
- Stable Markdown roots commit in order; the last streaming root stays plain/dynamic.
- Settled messages behind a live item cannot leap into history out of order.
- Hidden live content is not deleted from model conversation, messages, or sessions;
  completed output reaches Static verbatim.
- Ref-first live updates; bounded turn cancellation and late-callback quarantine.
- Enter submit, modified Enter newline, Backspace/Delete distinction, Escape cancel,
  Tab/arrow completion, history/draft restoration, Ctrl+O tasks, paused-goal R resume.
- Ctrl+C interrupts even when input is disabled; masked values never leak into logs,
  history, fixtures, or diagnostics.
- Theme defaults and historic Static palette behavior; no stdin queries from OSC helpers.
- Node >=22, ESM, exact Ink pin, `.js` local imports, strict TypeScript.

Out of scope: model/provider settings, agent completion logic, full transcript
virtualization, alternate-screen conversion, new suspension flows, publishing, and
unrelated refactors. Preserve unrelated worktree edits. Do not edit generated dist,
node_modules, user settings, credential files, or hand-edit the lockfile.

## Execution and ownership

Each task requires a runnable slice and its acceptance check before extending it.
Record commands/outcomes and environment in the implementation PR. Baseline failures
must be recorded, not silently attributed to v8. After fixing a failure rerun the
same check. Do not accumulate a large batch of dependent code before testing.

Suggested PRs:

1. **Compatibility**: M01–M03, with M08's mandatory compatibility gates.
2. **Viewport correctness**: M04 and its M08 regressions.
3. **Input modernization**: M05–M06, sequenced because both touch TextInput.
4. **Lifecycle/history**: M07, with startup erase behavior called out in release notes.
5. **Optional experiment**: M09 after mandatory slices are green.

Independent fixture/Unicode-helper/lifecycle-helper work can run in parallel after
M03. Integration into `chat.tsx`, `TextInput.tsx`, and `messages.tsx` needs one owner
at a time. M08 defines tests throughout, not a final testing-only phase.

## Task ledger

The detailed boxes below retain the original acceptance checklist, including unrun
platform checks. The task-level execution ledger and actual evidence are maintained in
[implementation evidence](ink-v8-implementation.md); an unchecked platform requirement
must not be inferred to have passed from the implemented code.

| ID | Priority | Depends on | Deliverable |
| --- | --- | --- | --- |
| M01 | required compatibility | — | baseline and version/API audit |
| M02 | required compatibility | M01 | minimal dependency/API upgrade |
| M03 | required compatibility | M02 | real renderer/input harness and smoke coverage |
| M04 | required modernization | M03 | whole dynamic-frame viewport guarantee |
| M05 | required modernization | M03 | native paste and proven parser cleanup |
| M06 | required modernization | M05 for TextInput integration | grapheme/cell-correct editing and widths |
| M07 | required modernization | M03 | guarded lifecycle and equivalent shutdown |
| M08 | required release gate | each slice; finally M04–M07 | matrix and release evidence |
| M09 | optional | M04, M08 | bounded offset-panel/performance experiment |

### M01 — Freeze a baseline before changing dependencies

- [ ] Capture `git status --short`, `node --version`, `npm --version`, and
  `npm ls ink react @types/react ink-spinner ink-testing-library react-reconciler`.
- [ ] Recheck pinned release metadata/public v8 docs using analysis source links.
- [ ] Audit source/test imports, render options, min/max width props, stream
  assumptions, control-response handlers, and deep/internal imports. Discovery found
  numeric minimums and `useWindowSize` already used; avoid unnecessary rewrites.
- [ ] Run focused baseline commands from the validation document and typecheck.
- [ ] Capture a deterministic long-transcript/stream run: output, terminal dimensions,
  startup erase sequences, resize behavior, rendering options. Isolate fixture data
  from actual user config and sessions.

Acceptance: a baseline report distinguishes preexisting failures from migration
regressions, names coverage limits, and records installed versions. No dependency
change precedes the baseline check.

### M02 — Minimal compatible upgrade

Files: `package.json`, npm-generated `package-lock.json`; source/tests only where
actual types/behavior require change.

- [ ] Run `npm install --save-exact ink@8.0.0` using the project's npm/lock format.
  Keep React/types 19.3.0 and Node >=22 absent a verified resolution problem.
  Never force peer installation.
- [ ] Inspect lock changes for intended transitive updates/duplicate renderers.
  Spinner peers permit v8; test rather than automatically replace it.
- [ ] Fix generic stream typing with public interfaces/guarded TTY capabilities;
  continue using `useWindowSize` for dimensions.
- [ ] Convert percentage min/max Box constraints only if discovered. Preserve valid
  percentage `width` and numeric constraints.
- [ ] Preserve incremental rendering, 15 FPS, Kitty auto-detection,
  `disambiguateEscapeCodes`, and `exitOnCtrlC: false`. Do not enable concurrency.
- [ ] Typecheck/rerun focused baseline tests immediately. Investigate timing/API
  causes of testing-library failures before replacing it.

Acceptance: a supported React render path, no ignored peer errors, focused tests and
typecheck green, no unrelated dependency drift. PR still needs M03 and M08 gates.

### M03 — Real renderer and input integration fixtures

Existing coverage: `tests/cli/messages.test.tsx`, `tests/cli/liveRegion.test.ts`,
`tests/cli/chat/liveMessages.test.tsx`, `tests/ui/components/MarkdownText.test.tsx`,
`tests/ui/TextInput.test.ts`, and `tests/ui/useInputSuggestions.test.tsx`.
Suggested new files: `tests/cli/inkRenderer.test.tsx`,
`tests/ui/TextInput.integration.test.tsx`, shared test-only utilities.

- [ ] Render a deterministic transcript/live-tail presentation with actual Ink
  `render()`, controllable Node streams, explicit dimensions, and cleanup.
- [ ] Exercise non-TTY PassThrough streams separately from a TTY-capable fixture.
  Fake TTY tests contracts, not emulator scrollback; add PTY/manual checks in M08.
  Do not cast a generic stream into an invented TTY unsafely.
- [ ] Feed bytes through stdin/parser, not just exported helpers: legacy/Kitty
  modifiers, probe replies, mouse/focus/cursor replies, keypad Enter, Ctrl+C, and
  bracketed paste. Include split/coalesced input events.
- [ ] Await updates/flush with documented APIs and React `act` where appropriate;
  fixed sleeps must not be the only success criterion.
- [ ] Ensure unmount closes timers/listeners/restores fixture globals. Mock providers
  and persistence; use temporary HOME/workspace when needed.

Acceptance: fixtures exercise real render/parser paths, have bounded timeouts, and
fail meaningfully on ordering, input actions, or cleanup regressions. Snapshots or
fabricated key objects alone do not satisfy this task.

### M04 — Make the viewport guarantee true

Files: `src/cli/commands/chat.tsx`, `src/cli/chat/liveRegion.ts`,
`src/cli/chat/messages.tsx`, `src/cli/chat/TaskBar.tsx`,
`src/ui/components/TextInput.tsx`; prefer an extracted pure allocator and small
presentation component. Keep turn/session/wizard logic outside presentation.

- [ ] Add regressions for four-row draft/suggestions; wrapping queue/debug/tips;
  pause banner; long diff paths; settled messages behind a live tail; many groups;
  tiny windows.
- [ ] Define one row-budget model using actual dimensions/allocated content widths.
  Include borders, padding, margins, headers, status, input, suggestions, task
  padding, metadata, and omission cues.
- [ ] Reserve input/cursor and essential status/cancel/resume affordances first.
  Deterministically reduce/hide debug, queue detail, expanded tasks, suggestions,
  and live-tail detail as space runs out; retain underlying data.
- [ ] Pass TextInput explicit input/suggestion row allowances; active suggestion and
  cursor stay visible. Do not count unseen suggestions as rendered rows.
- [ ] Budget the sum of live items, not a positive minimum per item. Bound all
  dynamic roles, including settled blocked messages and diff metadata.
- [ ] Remove minimum-width-20 assumptions exceeding available cells. Use compact
  borderless layout for tiny terminals; at one-row extreme prioritize editable
  prompt and retain actions via keys.
- [ ] Evaluate v8 `useBoxMetrics` client dimensions for nested geometry, with safe
  first-render sizing/equality-guarded updates to avoid feedback loops. Do not
  subtract Static history height from the normal-screen dynamic budget.
- [ ] Finalization commits full output, not clipped display copies. Never re-key
  Static on resize to reflow historic output.

Acceptance: actual dynamic frame fits rows for every matrix combination/resize;
no duplicated history or lost finalized content; first frame safe before measurement;
omission indicators fit budget. Pure allocation tests alone are insufficient.

### M05 — Native paste and parser-workaround cleanup

Files: `src/ui/components/TextInput.tsx`, `src/ui/inputBuffer.ts` as needed;
helper/integration tests.

- [ ] Route bracketed payloads through `usePaste` to insertion/normalization, not
  shortcut/submit dispatch. Prevent duplicate delivery through `useInput`.
- [ ] Preserve >=4-line compact blocks, exact normalized underlying content, ranges,
  masking, and history. Respect disabled-input policy; Ctrl+C remains available
  outside paste.
- [ ] Preserve ordinary non-bracketed text. Test chunked/coalesced paste wrappers;
  avoid speculative timer heuristics for terminals without bracketed support.
- [ ] Verify v8 drops actual unknown replies. Remove Kitty probe suppression only
  after tests establish literal pasted probe-shaped text survives.
- [ ] Retain modifier-based newline. Audit raw fallback strings against v8 parsing;
  remove only proven redundant encodings/update Ink-7 comments.
- [ ] Explicit safe policy: unsupported Ctrl combinations do not insert their letter;
  recognized shortcuts still act. Do not blanket-reject Meta text without testing
  non-ASCII/terminal behavior.
- [ ] Test Backspace/Delete/Escape, keypad Enter, legacy/Kitty Ctrl+C, disabled mode,
  completion/history, masking, and R resume alongside paste.

Acceptance: bracketed paste never submits/runs commands/toggles tasks/resumes;
literal probe payload survives; control replies never appear in the draft; typed
keys retain semantics. Release-note wording alone is not grounds to remove fallbacks.

### M06 — Grapheme editing and terminal-cell width consistency

Files: `src/ui/inputBuffer.ts`, `src/ui/components/TextInput.tsx`,
`src/cli/chat/messages.tsx`, Markdown/table/code width helpers where warranted.

- [ ] Implement small segmentation/cell-mapping helpers, tested before integration.
  Keep storage/paste offsets as UTF-16 indices; expose grapheme boundaries and
  cell columns separately. Use `Intl.Segmenter` or a justified alternative.
- [ ] Declare any new width dependency directly and regenerate the lock; align
  ANSI/emoji/CJK behavior with Ink 8 and existing wrap-ansi usage.
- [ ] Move horizontal cursor and delete/backspace by grapheme; highlight entire
  graphemes; maintain vertical preferred terminal-cell columns.
- [ ] Wrap without splitting graphemes. Handle a grapheme wider than the viewport
  deterministically without losing underlying content. Reserve prompt/cursor cells.
- [ ] Verify placeholder mappings across multiple blocks and Unicode boundaries;
  do not change persisted strings or existing trim policy silently.
- [ ] Fix background padding by visible cells; audit table/code/list width helpers.
  Remove manual prewrapping only after proving native-v8 parity.

Acceptance: CJK, surrogate-pair/ZWJ emoji, combining marks, and ANSI output wrap
correctly; editing never creates lone surrogates/split graphemes; vertical navigation
tracks cells; existing ASCII/paste tests stay green.

### M07 — Lifecycle protection and scrollback-preserving startup

Files: `src/cli/commands/chat.tsx`, existing session/turn lifecycle boundaries,
`src/ui/terminalColors.ts` if needed; prefer extracted shutdown helper/tests.

- [ ] Guard adoption, render creation, and exit waiting so synchronous render failure
  restores adopted terminal defaults.
- [ ] Inspect recorder/log/unmount cleanup to identify actual owners. Route `/exit`
  and Ctrl+C through one idempotent bounded shutdown: stop new work, abort active
  turn, honor bounded settlement, flush session/log, clean background resources/tasks,
  exit with no late screen callbacks.
- [ ] Test rejected `waitUntilExit`, cleanup failures, repeated interrupt. Report
  persistence errors without preventing restoration; avoid duplicate flushes/log
  endings/global listeners.
- [ ] Separately remove startup `ESC[3J` if adopting history-preserving startup;
  retain screen/cursor behavior only as needed. Prove preexisting history remains
  reachable and call out this behavior change in changelog.
- [ ] Verify cursor/raw-mode/Kitty/paste-mode restoration on normal/error exits.
  Keep OSC helpers write-only; compose signal handling with Ink rather than
  overriding it indiscriminately. SIGKILL recovery is out of scope.

Acceptance: slash exit, legacy/Kitty Ctrl+C, render failure, and rejected wait restore
terminal state/clean resources once; active callbacks are quiesced; persistence
flushes or reports bounded failure; no post-startup history-clear sequence. Startup
history behavior is explicit if changed.

### M08 — Integration, release gates, and handoff evidence

- [ ] Execute the companion matrix after each affected slice.
- [ ] Run full typecheck, tests, lint, build, package dry-run on integrated work.
- [ ] Verify clean npm install/peers in isolated checkout or CI, never destructively
  cleaning the user's worktree. Exercise actual Node 22 and supported developer
  runtime; engine declarations alone are not runtime coverage.
- [ ] Finish real terminal/PTY coverage: legacy and Kitty terminals, resize, normal
  scrollback, paste, interrupt, themes, Unicode, tiny layouts.
- [ ] Compare deterministic v7/v8 output/performance fixtures; investigate material
  increases and claim gains only with numbers/terminal evidence.
- [ ] Update CHANGELOG and relevant docs/guidance for actual behavior changes.
  Node-floor docs need no change if >=22 stays unchanged. Do not publish.
- [ ] Record versions, commands, matrix cells, limits, optional remaining work,
  and rollback instructions.

Acceptance: required gates pass; unavailable terminal/platform checks explicitly
say not run. Compatibility-only delivery lists M04–M07 as pending rather than
claiming their completion.

### M09 — Optional offset panels and measured simplification

Separate PR; not needed for compatibility or correctness fixes.

- [ ] Prototype offsets only for bounded suggestion/task detail panels; retain
  normal transcript history and keyboard selection visibility.
- [ ] Use positive offsets, measured nonshrinking content wrapper, correct client
  geometry, padding-aware bounds, resize/content clamping.
- [ ] Compare simpler list slicing for complexity/output/CPU; discard if no benefit.
- [ ] Evaluate animation/concurrency as separate justified experiments; rerun
  batching/Static/cleanup tests before adoption.

Acceptance: documented keep/drop decision, no virtualization claims or history/UX
regression, measurable benefit for any retained implementation.

## Rollout and rollback

Keep dependency/API changes distinguishable from improvements. For a verified v8
blocker, prepare a reviewed patch restoring Ink 7.1.1 and its npm-generated lock;
do not reset user changes or discard unrelated fixes. V8-only client metrics/offsets
must be reverted/adapted with rollback; portable Unicode/paste/lifecycle fixes can
remain if tested on v7. No silent runtime Ink-version fallback.

Do not release merely because TypeScript compiles: terminal-only regressions can
leave chat unusable despite green helpers. Isolate unrelated baseline failures
instead of expanding this migration into provider/model work.
