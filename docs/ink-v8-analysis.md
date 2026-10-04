# Ink v8 migration: analysis and decisions

Date: 2026-10-04. Repository baseline: haze 1.4.0, Ink **7.1.1**.
Status: historical pre-migration analysis. Required code slices have now been implemented;
see [implementation evidence](ink-v8-implementation.md) for executed checks and remaining runtime/emulator coverage gaps.

Read this first, then [implementation plan](ink-v8-migration-plan.md) and
[validation matrix](ink-v8-validation.md). Task IDs are the implementing-agent
handoff contract. Recheck upstream versions before execution.

## Executive recommendation

Upgrade to pinned **Ink 8.0.0** in a small compatibility PR first. Preserve normal
terminal scrollback, incremental rendering, the 15 FPS cap, and application-owned
interrupt handling. Follow with separately tested layout, input, Unicode, and
shutdown improvements. Do not bundle a full-screen rewrite or concurrent-rendering
experiment into the dependency upgrade.

Current Node >=22, React 19.3.0, and @types/react 19.3.0 satisfy v8 requirements.
The main risk is the interaction between a changed terminal renderer/parser and
haze's application-side layout estimates and Ink-7 input workarounds.

## Evidence and limits

Public upstream release notes, tagged documentation, and npm metadata were checked
on the date above. Repository inspection covered dependencies, Ink imports,
render options, transcript partitioning, live-region helpers, input buffer/component,
Markdown rendering, terminal colors, session lifecycle sampling, and test inventory.
This is source-based assessment, not an executed upgrade, benchmark, or reproduction
of every terminal failure described below.

Primary sources:

- [Ink v8.0.0 release and migration guide](https://github.com/vadimdemedes/ink/releases/tag/v8.0.0)
- [Ink v8 tagged README/API documentation](https://github.com/vadimdemedes/ink/blob/v8.0.0/readme.md)
- [Ink v8 scrolling example](https://github.com/vadimdemedes/ink/blob/v8.0.0/examples/scroll/scroll.tsx)
- [Ink 8.0.0 npm metadata](https://registry.npmjs.org/ink/8.0.0)
- [Ink 7.0 migration guide](https://github.com/vadimdemedes/ink/releases/tag/v7.0.0)
- [Ink 7.1 release](https://github.com/vadimdemedes/ink/releases/tag/v7.1.0)
- [Ink 7.1.1 release](https://github.com/vadimdemedes/ink/releases/tag/v7.1.1)
- [Spinner 5.0.0 metadata](https://registry.npmjs.org/ink-spinner/5.0.0)
- [Testing library 4.0.0 metadata](https://registry.npmjs.org/ink-testing-library/4.0.0)

Ink 8.0.0 was released on 2026-10-03 and was npm's stable latest when researched.
The tagged README retains an upcoming-version notice; npm/release metadata establishes
release status. Use pinned-version documentation rather than moving `main` docs.

## Dependency compatibility

| Dependency/setting | Current | Target/action |
| --- | --- | --- |
| `ink` | exact `7.1.1` | exact `8.0.0`; regenerate lockfile through npm |
| Node engine | `>=22` | preserve; test actual Node 22 |
| `react` | exact `19.3.0` | preserve: v8 peer is `>=19.3.0` |
| `@types/react` | exact `19.3.0` | preserve: optional v8 peer is `>=19.3.0` |
| `ink-spinner` | `5.0.0` | peers Ink `>=4.0.0`, React `>=18.0.0` permit v8; smoke-test |
| `ink-testing-library` | `^4.0.0` | React types peer `>=18.0.0`; no Ink peer constraint; smoke-test |
| `wrap-ansi` | `10.0.2` | preserve; v8 declares `^10.0.2`; not proof all layout estimates match |
| React DevTools | not direct | optional `react-devtools-core >=6.1.2`; do not install just for metadata |

Ink stays ESM. Its reconciler changes to `react-reconciler ^0.34.0`; use public Ink
APIs, not internals. TypeScript NodeNext/.js imports need no overhaul.
Testing-library's development history includes older Ink/React, so permissive peers
are not certification. Inspect the resolved lock graph for duplicate/incompatible
React/reconciler versions. Never use `--force` or `--legacy-peer-deps` to hide problems.

## Explicit v8 breaking changes and local impact

| Upstream change | Current haze evidence | Migration requirement |
| --- | --- | --- |
| React >=19.3 | manifest already matches | verify resolved peers; no speculative React upgrade |
| Box `minWidth`/`maxWidth` numeric-only | discovered Box constraints in `chat.tsx` are `minWidth={0}` | audit production/test JSX; preserve valid numeric constraints |
| render/hook streams typed as generic Node streams | chat uses `useWindowSize()`; no discovered `useStdout().columns` production usage | typecheck fixtures and TTY assumptions; narrow capabilities |
| `useInput` discards unrecognized terminal control sequences | TextInput has Kitty probe and raw modified-Enter helpers | integration-test real bytes; remove only proven redundant workarounds |

Numeric constraints do **not** invalidate `width="100%"` or percentage height.
For relative min/max constraints calculate numeric cells with `useWindowSize()` or
parent `useBoxMetrics()`; handle initial measurement safely. `PassThrough` support
does not make every stream a TTY: retain capability checks for `.isTTY`,
`.setRawMode`, `.columns`, `.rows`, and resize.

The parser change matters for paste: a literal pasted string resembling `[?0u`
must not be treated as a terminal probe solely by its text. Distinguish provenance.

## Relevant additions and fixes

### New or extended in v8

- Box `contentOffsetX`/`contentOffsetY` with hidden overflow support scrolling/clipping.
- `useBoxMetrics()` and `measureElement()` add `clientWidth`/`clientHeight`
  excluding borders. Padding still matters; these are not browser CSS APIs.
- Generic Node stream support enables real Ink stream tests; raw mode is enabled
  only on TTY stdin with the appropriate capability.
- Application-keypad Enter is recognized as Return.
- Native WebSocket replaces DevTools' runtime `ws` dependency.

### Improvements to existing behavior, not newly introduced features

The release reports incremental unchanged-line prefix improvements, Static fixes
across clear/abandoned concurrent renders, blank-row/history preservation,
viewport shrink/cursor fixes, style inheritance, clipping, multiline truncation,
wide/combining characters, tabs/CRLF, control-character stripping, focus, Kitty,
combined input/Ctrl+C, suspension, bounded caches, Yoga cleanup, and listener cleanup.
These are upstream claims to test, not measured local gains.

`onRender` follows frame writing but does not prove stream flush; use
`waitUntilRenderFlush()` for flush-sensitive ordering assertions.

### Already available in the v7 baseline

Do **not** describe these as v8-only benefits: `useWindowSize`, `useBoxMetrics`,
`usePaste`, `useAnimation`, `alternateScreen`, `interactive`, `suspendTerminal`
(7.1), element position metrics (7.1.1), or haze's enabled incremental rendering.
V7's Backspace/Delete and Escape/Meta changes are already reflected in haze.
Revalidate; do not apply a v6 migration guide blindly.

## Existing implementation assessment

Line numbers are baseline pointers; navigate by symbols after edits.

### 1. Preserve the transcript architecture

`ChatScreen` (`src/cli/commands/chat.tsx`) renders Header and committed items through
`<Static>`, followed by a live tail and controls. `partitionDisplayMessages`
(`src/cli/chat/transcriptPartition.ts`) commits only an ordered prefix: settled
notices after an earlier live item stay dynamic. Assistant Markdown commits stable
preceding roots; the final root remains plain/dynamic because later text can
reclassify it as a heading, table, list, or fence. `AssistantMarkdownChunkView` and
`MessageView` in `messages.tsx` preserve this split.

This is necessary application logic, not obsolete scaffolding. Native offsets must
not replace normal terminal history. Do not re-key/remount Static on resize or theme
changes. Historical output intentionally retains its old palette. `useLiveMessages`
(`liveMessages.ts`) protects add/delta/finalize bursts with refs before React flushes;
preserve that protection.

### 2. Current viewport guarantee is incomplete — high priority

Confirmed from source, not a reproduced Ink 8 scrollback failure:

- `chat.tsx` 649–662 estimates input as three rows, explicitly permitting multiline
  overflow. TextInput displays up to four input rows plus suggestions.
- Queue/debug/tip/status content can wrap beyond logical counts; the pause banner
  is absent from fixed row accounting.
- Positive minimum per-item budgets can overflow with many dynamic items or when
  fixed controls consume every row.
- Settled messages behind an active tail are not uniformly clamped by `MessageView`.
- Diff path/metadata/preview notices can wrap; input and Markdown impose minimum
  width 20 even when less width is available.

V8's scrollback fixes do not prove arbitrary oversized frames safe. Build a coherent
allocator and bounded rendering for **every** dynamic section: borders, padding,
margins, headers, wrapped metadata, suggestions, and omission indicators. Define a
compact tiny-terminal mode instead of giving every section a positive allocation.

Use v8 metrics for actual component geometry where useful, with pure allocation
and safe first-render limits so feedback cannot overflow before measurement arrives.
Extract helpers/presentation rather than expanding the 808-line orchestrator.

### 3. Application Unicode handling remains incorrect — high priority follow-up

`wrapDisplayValue`/`cursorPosition` in `src/ui/inputBuffer.ts` count UTF-16 code units
as columns. TextInput moves/deletes one code unit and highlights one indexed code
unit. This can split surrogate pairs, misplace combining accents/ZWJ emoji, and
underestimate CJK cell width. `fullWidthLines` in `messages.tsx` pads by string length.
Renderer improvements cannot correct these application indices.

Keep string offsets for slices/paste ranges, navigate grapheme boundaries, and map
them to cells. Node 22 `Intl.Segmenter` provides segmentation; select an ANSI-aware
width helper compatible with Ink's policy. If importing `string-width`, declare it
directly, not transitively. Audit Markdown `visibleLength`, table widths, code
clipping, hanging indent, and user backgrounds. Do not turn placeholder offsets
into cell indices accidentally.

### 4. Replace heuristic paste dispatch, cautiously remove parser filters

TextInput handles everything through `useInput`; a single insertion of >=4 lines
becomes a display-only paste placeholder. Chunk shape stands in for paste boundaries.
Unknown shortcuts can reach insertion. `isKittyQueryResponseInput` suppresses probe
text regardless of provenance; raw modified-Enter helpers are Ink-7 compatibility code.

Use existing `usePaste` for bracketed payloads, preserving CRLF normalization, full
content, placeholders, masking, and history. Paste must never submit on embedded
Enter or invoke slash/task/resume/interrupt actions. Preserve non-bracketed terminal
behavior; do not invent timer-based detection without need. Define unsupported
control-key policy. Remove probe filters after v8 filtering tests, and preserve
literal paste. Keep modifier-based Enter; remove raw fallbacks only when their
terminal paths are proven covered. Keep app interrupt ownership initially.

### 5. Guard terminal adoption and unify exit lifecycle

Confirmed gap: `chatCommand` adopts defaults and calls `render()` before its
`try/finally`; synchronous render failure bypasses OSC reset. Startup explicitly
writes `ESC[2J ESC[3J ESC[H`, clearing preexisting scrollback. V8 cannot fix an erase
issued by haze. Evaluate removing startup `3J` as a separate tested behavior change;
distinguish intentional startup erase from renderer-induced mid-stream erase.

Confirmed asymmetry: `/exit` flushes the recorder and ends the LLM log before
`exit()` (`chat.tsx` 433–437); Ctrl+C calls `exit()` directly. This is a persistence
risk, not proof of lost data: inspect recorder/unmount cleanup before implementation.
Build one bounded/idempotent shutdown path, cancel active work, await owned
persistence, prevent late display callbacks, and restore defaults in controllable
failure paths. Retain turn quarantine and shared process cleanup; do not build a
competing process manager or promise cleanup after SIGKILL.

### 6. Revalidate rendering modes and performance before broad adoption

Keep `incrementalRendering: true`, `maxFps: 15`, Kitty auto-detection with
`disambiguateEscapeCodes`, and `exitOnCtrlC: false`. Keep concurrent rendering and
alternate screen off. Benchmark bytes, renders, timing, and memory with deterministic
streams on v7/v8. Do not raise FPS or replace timers just because animation helpers
exist. Concurrency is a later experiment requiring Static, ref routing, effect, and
input tests. `useAnimation` adoption needs measured benefit.

## Adoption decisions

| Capability/work | Decision | Reason |
| --- | --- | --- |
| Dependency/API compatibility | required first slice | isolates v8 regressions |
| Full dynamic-frame budget | prioritized follow-up | real local guarantee gap |
| Metrics/client dimensions | selective adoption | avoids border arithmetic; first-frame safety required |
| Native paste/parser cleanup | prioritized follow-up | provenance and accidental-action prevention |
| Unicode cell/grapheme logic | prioritized follow-up | local bugs renderer cannot fix |
| Lifecycle guard/shared exit | prioritized follow-up | restoration and persistence parity |
| Startup scrollback preservation | recommended explicit behavior change | application currently erases history |
| Offsets for suggestion/task panels | optional bounded experiment | needs usability proof |
| Entire transcript offset scrolling | reject for migration | changes scrollback contract |
| Alternate screen / concurrent mode | defer | separate UX/concurrency risk |
| Blanket wrapping-workaround removal | reject | require native-v8 equivalence reproducers |
| Suspension integration | defer absent a needed flow | predates v8; avoid speculative features |

Offset experiment: use positive offsets, separately measure a `flexShrink={0}`
content wrapper, and clamp on resize. With padding on the content wrapper, bound
by content height minus viewport client height. Client dimensions exclude borders,
not padding. Clipping is **not virtualization** and does not inherently reduce
hidden-content layout. Keep selection visible and provide omission cues.

## Completion definition

The compatibility PR can finish without every follow-up if remaining work is clearly
labeled. Full modernization requires mandatory follow-ups and terminal coverage in
the companion files. Component snapshots alone do not prove scrollback, raw-mode,
keyboard-protocol, or real resize correctness.
