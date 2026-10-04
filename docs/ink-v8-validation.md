# Ink v8 migration: validation and evidence matrix

Date: 2026-10-04. For implementing agents, paired with the
[analysis](ink-v8-analysis.md) and [task plan](ink-v8-migration-plan.md).
**This file specifies the validation protocol. Executed checks and coverage gaps are
recorded separately in [implementation evidence](ink-v8-implementation.md).**

## Check sequence

Before M02, record current dependency/runtime versions and run:

```bash
npm run typecheck
npm test -- tests/cli/messages.test.tsx tests/cli/liveRegion.test.ts tests/cli/chat/liveMessages.test.tsx tests/cli/chat/TaskBar.test.tsx tests/ui
```

Run these again immediately after the minimal upgrade. Then run the affected new
integration tests after each slice, using their final file names. Do not execute
placeholder paths before creating the tests.

Integrated/release checks:

```bash
npm run typecheck && npm test && npm run lint && npm run build
npm pack --dry-run
npm ls ink react @types/react ink-spinner ink-testing-library react-reconciler
```

Build generates dist through the official script; never edit dist manually. Run
clean-install checks via `npm ci` only in an isolated checkout/CI environment, not
as an unsolicited cleanup of an active worktree. Check actual Node 22 plus the
supported development runtime. Validate lockfile resolution and peer warnings.
If a command fails, retain the failing command/output and rerun that same check
after the fix. Separate unrelated preexisting failures explicitly.

For custom assertions or fixture runners, use the coding tool's
`purpose=validation` when available. A command that prints success without failing
its process on assertion failure is not a check. Avoid compound shell shapes that
mask failures. Do not claim runtime coverage from an install or typecheck alone.

## Existing coverage map

| Area | Current tests | What they do not prove |
| --- | --- | --- |
| Transcript partition/stable roots | `tests/cli/messages.test.tsx`, `tests/ui/MarkdownText.test.ts` | actual terminal history across incremental redraws |
| Tail wrap/clamp | `tests/cli/liveRegion.test.ts` | total ChatScreen height including all chrome |
| Rendered Markdown | `tests/ui/components/MarkdownText.test.tsx` | full-screen resize and scrollback preservation |
| Live bursts | `tests/cli/chat/liveMessages.test.tsx` | whole-screen concurrent rendering correctness |
| Tasks | `tests/cli/chat/TaskBar.test.tsx` | task/input/queue combined viewport budget |
| Keyboard helpers | `tests/ui/TextInput.test.ts` | actual v8 stdin parsing or bracketed paste dispatch |
| Buffer/paste mapping | `tests/ui/inputBuffer.test.ts` | cell/grapheme correctness unless new cases added |
| Completion races | `tests/ui/useInputSuggestions.test.tsx` | active selection staying visible under tight row budgets |
| Terminal OSC | `tests/ui/terminalColors.test.ts` | application render-failure restoration and exit ordering |

Keep existing tests; add focused integration rather than converting every unit test
into a terminal test. `ink-testing-library` is useful for frames/components, but real
Ink render streams and PTY/emulator checks are separate evidence levels.

## Deterministic fixture requirements

Use synthetic messages, tasks, queued follow-ups, Markdown, and provider mocks.
Avoid real settings, provider credentials, session history, network model calls, or
secret files. Use temporary HOME/workspace for application-level startup. Restore
cwd/environment/globals and close every render, stream, timer, and listener.

A practical harness should offer:

- Explicit columns/rows and resize events; no dependency on CI terminal dimensions.
- Frozen time/controlled spinner ticks where useful, controllable add/delta/finalize.
- Generic Node stream render mode and a capability-correct fake TTY mode.
- Captured raw ANSI bytes **and** rendered/screen-state assertions. Counting raw
  newline characters is not counting the dynamic viewport's rows.
- Bounded asynchronous waits and documented frame flush synchronization.
- An actual PTY/emulator/manual layer for history/cursor/raw-mode properties.

Prefer extracting a pure chat presentation boundary over mounting ChatScreen's
real settings/session machinery simply to measure layout. Test orchestration and
shutdown separately with injected owners. Do not add a PTY dependency automatically:
use available runners first, otherwise justify a maintained cross-platform choice
or provide a repeatable manual protocol.

## Observable scenario matrix

Run compatibility rows for M03/M08 even if modernization is deferred. Run all
mandatory modernization rows before claiming the full plan implemented.

| ID | Scope/task | Scenario | Required observation |
| --- | --- | --- | --- |
| V01 | compatibility M02 | install/build at Node 22 with React/types 19.3 | peers valid; no force flags; spinner/harness mount/unmount |
| V02 | compatibility M03 | generic non-TTY stdin/stdout/stderr | no TTY-property crash or raw-mode call; final noninteractive frame follows v8 contract |
| V03 | compatibility M03 | long Static transcript + incremental plain tail | committed chunks appear once/in order; no mid-stream history erase/replay |
| V04 | compatibility M03 | paragraph→heading/table/list/fence while streaming | unstable root stays dynamic; preceding stable roots commit once |
| V05 | compatibility M03 | narrow/short then wide/tall resize | no duplicates/lost content; cursor remains usable; historic Static not re-keyed |
| V06 | compatibility M03 | unknown mouse/focus/cursor/Kitty replies | draft stays unchanged; no actions; real pasted literal tested separately |
| V07 | compatibility M03 | Enter/keypad Enter/modified Enter; legacy and Kitty Ctrl+C | submit/newline/interrupt behavior preserved, including disabled input |
| V08 | compatibility M03 | add→delta→finalize before React flush | correct text/order and no stranded live tail |
| V09 | modernization M04 | 80×24, 40×12, 20×6, 10×3, 1×1 with multiline input | actual dynamic frame fits; cursor visible; tiny layout deterministic |
| V10 | modernization M04 | tasks expanded + queue + pause + debug + suggestions + tips | all sections and indicators within aggregate budget |
| V11 | modernization M04 | several live groups and settled notices behind first live item | order retained; settled dynamic text cannot bypass cap |
| V12 | modernization M04 | long path/handle/diff metadata, wrapped tip/status | cell-width rows counted; hidden diffs/notices correctly indicated |
| V13 | modernization M04 | clamp large streaming output then finalize | full untruncated output enters Static and durable text unchanged |
| V14 | modernization M05 | bracketed paste split across reads, embedded LF/CRLF/shortcuts | one insertion, no submit/shortcut side effect; normalized full text retained |
| V15 | modernization M05 | >=4-line paste, multiple blocks, history/edit/mask | placeholders/ranges stay valid; masking never exposes value |
| V16 | modernization M05 | pasted `[?0u`, slash, R, Ctrl-like bytes | literal payload policy enforced; no probe filter drops ordinary paste text; no actions |
| V17 | modernization M05 | unsupported Ctrl keys; Tab/arrows/Escape/history/R | explicit control policy; recognized controls and completions preserved |
| V18 | modernization M06 | `界界`, `🙂`, `e` + combining accent, ZWJ family | correct cell wrapping/cursor, complete-grapheme editing, no lone surrogates |
| V19 | modernization M06 | ANSI styles, tabs/CRLF, table/code/list/user background | width/alignment/style preservation; no control sequence corruption |
| V20 | compatibility + M07 | normal `/exit`, legacy/Kitty Ctrl+C, repeated exit | modes/cursor restored; bounded cleanup; modernized path flushes owned persistence once |
| V21 | modernization M07 | synchronous render throw, rejected exit wait, cleanup failure | OSC defaults restored; bounded failure reported; no orphan resources |
| V22 | modernization M07 | exit during active turn + late callbacks | no updates/new writes into exited UI; cancellation/persistence settled truthfully |
| V23 | modernization M07 | startup with recognizable prior terminal history | if startup 3J removed, history remains accessible; distinguish baseline intentional erase |
| V24 | compatibility M08 | blank Static rows, nested bg/theme switch, clear/new session | blank/style output correct; history not replayed/recolored by live theme changes; clear matches intended session semantics |
| V25 | optional M09 | offset panel shrink/grow, changed items, border/padding | positive/clamped offsets; selected item visible; no unbounded hidden layout claim |
| V26 | performance M08 | identical long stream/resize/burst workload v7 vs v8 | bytes/frames/time/memory recorded; regression explanation or fix |

Paste policy: bracketed paste is data, not commands. Normalize line endings, preserve
underlying text, and do not interpret embedded control bytes as shortcuts. Rendering
must not execute ANSI from payloads; test display sanitization separately from value
preservation. If an unsafe display character needs sanitizing, do not silently mutate
submitted data without documenting and testing that decision.

For Unicode tests, compare string slices/UTF-16 indices separately from display
cells. Terminal emoji width can vary: record tested terminal policies and avoid
promising universal emulator equivalence based on one width library.

## Terminal protocol: repeatable manual/PTY smoke

Required representative environments: one legacy keyboard terminal, one Kitty/CSI-u
capable terminal, and tmux/passthrough where available. macOS/Linux are useful
representatives; exercise Windows Terminal if Windows support is claimed by the
release. Missing platforms are coverage gaps, not inferred passes. Test with CI/non-TTY
streams separately. A browser runner does not replace these terminal checks.

1. Start in a disposable workspace/home with fixture settings and mocked provider;
   print a unique history marker before launching. Record emulator/version, shell,
   multiplexer, dimensions, runtime, Ink/React versions, and flags.
2. Stream a multi-screen response with blank lines, lists, tables, code fences,
   Unicode, tool diffs, and notices. Scroll backward while the tail updates; prior
   transcript must remain accessible and not replay on each tick.
3. Resize while streaming, including short/narrow windows; add a multiline draft,
   suggestions, tasks, queue, pause banner, and debug panels. Input/cursor/actions
   must remain usable. Capture both initial and post-resize frames.
4. Paste multiline content and literal probe-shaped text. Check Enter versus
   modified Enter, completion, history, task toggle, Escape cancellation, R resume,
   and Ctrl+C both idle and busy.
5. Switch theme: new output/defaults change, old Static output remains untouched.
   Test clear/new session without confusing intended display clearing with history
   corruption. If suspend/resume is introduced, test paired terminal ownership.
6. Exit normally and by interrupt; inspect echo/raw mode/cursor/default colors and
   keyboard/paste modes. Verify no running fixture children/listener leaks. Repeat
   startup/exit and simulate render failure in the automated lifecycle harness.
7. Record pass/fail plus evidence for each matrix row, not simply “looks good”.

Baseline startup currently sends `ESC[3J`. Compatibility tests may explicitly allow
that one initial sequence; fail on unexpected later scrollback erasure. After M07's
startup change, assert no startup `3J` and check actual history. Do not blanket-ban
all ANSI clear-screen sequences: clearing a viewport and erasing scrollback differ.

## Performance comparison

Same workload, dimensions, runtime, terminal mode, FPS and fixture timing on both
versions. Include warm-up and multiple samples. Record elapsed time, output bytes,
frame/write counts, memory trend over a long stream, and perceived flicker/scrollback.
Do not turn noisy wall-clock comparisons into flaky unit assertions. Establish
limits from baseline; investigate sustained resource growth or repeatable large
regressions rather than inventing an unsupported percentage target. Only retain
new measurements/hooks/offsets/animation changes that simplify code or improve a
measured outcome without correctness regressions.

## Evidence template for implementing agents

```markdown
### Slice/task IDs
- Commit/patch scope:
- Ink / React / Node / npm versions:
- Baseline relevant failures:
- Commands run and actual exit results:
- Matrix rows covered automatically:
- PTY/emulator versions and rows covered manually:
- Observed behavior/performance differences:
- Unrun checks and concrete reason:
- Remaining required follow-ups / optional experiments:
- Rollback compatibility notes:
```

Plan-author status: npm peer/runtime metadata and repository source/test inventory
were inspected; application tests, upgrade install, benchmarks, and real terminal
interactions were **not run** as part of this planning-only request. Validation of
the Markdown artifacts is recorded in the author response, not implied by unchecked
future implementation tasks.
