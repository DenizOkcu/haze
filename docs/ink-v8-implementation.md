# Ink v8 migration: implementation evidence

Date: 2026-10-04. Package remains haze 1.4.0; nothing was published.

## Outcome ledger

| Task | Outcome |
| --- | --- |
| M01 | Baseline captured before dependency edits: Node 26.7.0, npm 12.1.0, Ink 7.1.1, React/types 19.3.0, reconciler 0.33.0. Typecheck and the specified 86 focused tests passed. A deterministic 100-item transcript fixture also passed on v7. |
| M02 | Exact Ink 8.0.0 installed through npm; React/types unchanged. Resolved reconciler 0.34.0, no duplicate React/Ink renderer, no forced peers. Direct string-width 8.3.0 added for application cell geometry. Initial post-upgrade typecheck and 87 focused tests passed. |
| M03 | Actual Ink render fixtures cover capability-correct TTY streams and generic non-TTY PassThrough streams, incremental Static ordering, resize, stdin parsing, flush ordering, and listener/raw-mode cleanup. Existing partition/stable-root and synchronous live-burst tests retained. |
| M04 | DynamicFrame allocates the complete dynamic viewport independently of Static. Input demand reports actual draft/suggestion rows; useBoxMetrics narrows nested input client width with safe first-render arithmetic. Borders, status/activity, queue/debug/tasks, and the aggregate live preview are bounded; optional detail yields to input/status. Tiny windows are borderless, including an editable one-cell prompt. Displayed live items share an aggregate allocation; settled blocked notices also honor display caps. Full underlying messages remain unchanged. |
| M05 | Native usePaste receives bracketed data separately from typed keys. Split/coalesced wrappers, normalized CRLF, >=4-line compact blocks, literal probe text, slash/R/control payloads, disabled paste, masking, and unsupported Ctrl policy have real stdin coverage. The Kitty payload regex was removed after parser tests; raw modified-Enter fallbacks remain conservatively. |
| M06 | Intl.Segmenter editing boundaries and string-width cell columns replace code-unit editing/width arithmetic. CJK, emoji, combining marks, ZWJ families, multiple paste-block mappings, code clipping, table wrapping/widths, and background padding use Unicode-aware helpers. UTF-16 storage offsets and submitted strings are preserved. |
| M07 | Shared idempotent shutdown stops submissions, aborts and awaits active work (12-second bound), quarantines callbacks, flushes session/log, and cleans background resources/tasks (5-second bounds per cleanup phase). Slash exit and both interrupt encodings exercise ChatScreen with real Ink and injected owners. Guarded adoption/render/wait restores defaults on failures. Startup ESC[3J was removed; OSC helpers remain write-only. |
| M08 | Typecheck, full suite, lint, build, package dry-run, isolated clean install, POSIX PTY protocol checks, and a deterministic renderer comparison executed. Remaining Node 22 and emulator/platform gaps are explicit below; this is not complete cross-platform release certification. |
| M09 | Deferred as optional. No offsets, alternate-screen mode, concurrency, animation overhaul, or transcript virtualization introduced. |

## Commands and results

Baseline, before upgrading:

```sh
node --version
npm --version
npm ls ink react @types/react ink-spinner ink-testing-library react-reconciler
npm run typecheck
npm test -- tests/cli/messages.test.tsx tests/cli/liveRegion.test.ts tests/cli/chat/liveMessages.test.tsx tests/cli/chat/TaskBar.test.tsx tests/ui
npm test -- tests/cli/inkRenderer.test.tsx
```

The baseline focused checks passed. Initial fixture-authoring mistakes (using a
nonexistent testing-library `writes` property, and counting replayed debug frames as
raw terminal writes) were corrected before upgrading; they were not product failures.
Actual terminal-write assertions use the real renderer, not testing-library debug output.

Integrated checks:

```sh
npm run typecheck && npm test && npm run lint && npm run build
npm pack --dry-run
```

Executed successfully: full suite **2001 passed, 6 skipped** (172 passed test files,
6 skipped eval files). The model-backed evals require external model configuration
and were not enabled. The official build generates dist; no generated files were
hand-edited. Package dry-run succeeded; package version and Node >=22 floor remain unchanged.

One unrelated, preexisting full-suite failure was found: the direct DeepSeek
provider-wizard test expected 384000 output tokens while the unchanged direct
provider preset supplies 393216. Only that stale test expectation was corrected;
no provider/model production configuration changed. The same full gate command
subsequently passed. Other intermediate failures were corrected and their checks
rerun: ES2022 lacks Array.findLast typings; a legacy key fixture needed separate
physical reads rather than coalescing Ctrl+B and Return into unbracketed data;
the settled-message assertion now distinguishes Static output from explicitly
bounded dynamic output; the PTY runner must drain stdout during exit flushing.

A disposable directory containing only package.json/package-lock.json was used
for `npm ci` and `npm ls`. Clean installation passed, audited 281 packages with
zero reported vulnerabilities, and resolved one Ink 8/React 19.3/reconciler 0.34
graph. The initial `npm ci --prefix` invocation failed under npm 12's prefix
handling; changing into the same disposable directory made the clean install pass.
The active worktree/node_modules were not cleaned to perform this check.

## Automatic coverage and limits

- **V01:** developer-runtime peers/install/build pass. Actual Node 22 execution is
  **not covered**: `npx --package node@22 node --version` still selected Node 26;
  the isolated Node package did not provide an executable because its install
  script was blocked, and the requested `node-darwin-arm64@22` binary package was
  unavailable from the configured registry. No engine declaration is presented as
  runtime evidence. Run the focused suite/build on a provisioned Node 22 runner
  before release certification.
- **V02–V08:** generic-stream final output, actual incremental history writes,
  parser replies/keypad/modifiers/interrupts, resize, stable Markdown roots,
  transcript partitioning, and live add/delta/finalize bursts are tested.
- **V09–V13:** real Yoga geometry fits at 80×24, 40×12, 20×6, 10×3, and 1×1,
  including many pending messages and wrapped panels, then resizes back. Fixed
  outer bounds protect diff/metadata rendering too; this is not virtualization.
  Static gets original finalized messages, not clipped display copies.
- **V14–V18:** real bracketed input, compact paste ranges, literal probe payload,
  shortcuts, disabled input, masking, and complete-grapheme Backspace are tested.
  Existing completion/history helper tests remain. Manual terminal behavior for
  every keyboard/history combination is not inferred from these checks.
- **V19:** application geometry is cell-aware and existing Markdown/code/table
  tests pass. string-width's emoji policy is not a universal emulator guarantee.
- **V20–V22:** actual ChatScreen slash/legacy/Kitty exit and repeated interrupt
  flush owned session persistence once; synthetic active-turn callbacks are
  quarantined after exit. Injected lifecycle tests cover adoption/render/wait/
  cleanup failures and stalled settlement. Persistence failure is reported without
  blocking restoration.
- **V23–V24:** PTY output does not contain ESC[3J and Static history is emitted once.
  Theme/OSC tests pass. Accessible emulator scrollback and historic live theme
  switching still require the companion manual protocol.
- **V25:** not run; optional M09 deferred.
- **V26:** renderer-only comparison below. It does not benchmark provider or whole
  ChatScreen orchestration, interactive perceived flicker, or a multi-hour stream.

## POSIX PTY interaction

Repeatable commands (no provider/config/session access):

```sh
python3 scripts/check-ink-pty.py
python3 scripts/check-ink-pty.py --kitty
# For a human emulator check:
node --import tsx scripts/ink-terminal-fixture.tsx
```

Both automated modes passed on macOS with Python 3.9 and Node 26.7.0. The runner
negotiates simulated Kitty support when requested, sends split bracketed Unicode/
probe/slash/R paste, verifies it did not exit, submits it, resizes through the tiny
matrix, interrupts, and checks raw-mode and bracketed/Kitty restoration plus no
Static replay or scrollback erase. Captured byte totals vary with spinner/frame timing.

A POSIX PTY is **not a terminal emulator**. Actual legacy/Kitty emulator versions,
tmux/passthrough, Linux, Windows Terminal, scrollback accessibility, emoji-font
policy, and live theme changes were **not manually exercised**. Use the companion
validation protocol for those platform/UX acceptance checks; no browser runner
was available or substituted for terminal testing.

## Renderer comparison

```sh
node --expose-gc scripts/ink-render-benchmark.mjs <isolated-ink7-install> 3
node --expose-gc scripts/ink-render-benchmark.mjs . 3
```

Both use React 19.3.0, Node 26.7.0, explicit 80×24/40×12 dimensions, normal screen,
incremental rendering, configured maxFps 15, 1000 Static records, 60 forced-flush
tail updates, four resizes, one warm-up, and three measured samples. Forced flushes
bypass normal scheduling, so elapsed times are microbenchmark data, not interactive FPS.

| Metric | Ink 7.1.1 | Ink 8.0.0 |
| --- | --- | --- |
| Bytes per sample | 36410 | 35070 |
| Writes / frames | 258 / 66 | 258 / 66 |
| Elapsed ms, samples | 66, 59, 49 | 83, 62, 54 |
| Pre-GC heap delta, bytes | 10878992, 15645752, 12581584 | 20150824, 32036768, 27863648 |
| Post-cleanup/GC retained delta, bytes | 649312, 578592, 481688 | 212664, 187768, 217256 |

V8 writes fewer bytes but allocates more transient heap in this workload. Retained
heap after cleanup/GC stays roughly 0.2 MB per v8 sample instead of growing with
successive samples. This does not establish a leak-free long-running application
or a CPU speedup; no performance gain beyond measured output bytes is claimed.
No new runtime performance hook/offset/animation feature was adopted.

## Rollback and release handoff

For a verified v8-specific blocker, make a reviewed dependency patch restoring
Ink 7.1.1 through npm, never reset the user's worktree or hand-edit the lockfile.
Adapt DynamicFrame's client metrics if rolling back; Unicode/paste/shutdown changes
are portable but must be checked again on v7. Do not silently choose Ink at runtime.
Before publishing, close the actual Node 22 and named-emulator/platform coverage
gaps above. The detailed original checklist is a protocol, not a blanket claim
that every platform observation has been completed.
