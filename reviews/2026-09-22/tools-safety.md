# File tools, safety, and output integrity

See [README](README.md) for baseline and severity definitions. All items remain open. Security findings below are source-traced; no real secret file was read, copied, or used in a reproduction.

## TS-01 — Bulk-replacement discovery reads protected files before guards

**Priority:** P1 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/llm/tools/replaceInFiles.ts:59-93`, `src/llm/tools/replaceInFiles.ts:103-108`, `src/llm/tools/workspaceFile.ts:36-45`.

Only the search root passes `prepareWorkspaceRead`. Descendant files go directly to `readUtf8Prefix`; per-file protection occurs later in the mutation phase. A broad dry run over an unignored protected-name file can return its matching text in `before`/`after` and stored preview output. Even a non-dry-run can read and assemble the sensitive preview before eventually refusing to write. Gitignore is not a substitute for the unconditional secret boundary.

**Smallest fix:** run the shared lexical/real-path read guard on every candidate before opening it, in both preview and apply modes. Decide explicitly whether protected descendants are skipped with safe counts or cause a terminal refusal; never echo contents. Keep per-file mutation checks too.

**Acceptance:** mock filesystem content/access, or use policy-approved synthetic fixtures, to assert protected descendants are never opened; cover ignored overrides, a directory scan, symlink aliases, dryRun, expectedCount mismatch, and stored preview handles. Do not test against actual credentials.

## TS-02 — grep's includeIgnored option never changes ripgrep traversal

**Priority:** P2 · **Evidence:** source-traced · **Confidence:** high.

**Locations:** `src/llm/hazeTools.ts:192-208`.

`includeIgnored` bypasses the root guard but is absent from the ripgrep arguments. Searching an ignored directory tree with the option enabled still uses ripgrep's default ignore and hidden-file behavior. The tool can truthfully execute yet incorrectly report no matches for an explicitly requested scope. Blessed external roots likewise do not automatically change child traversal rules.

**Smallest fix:** apply the intended ignore/hidden flags when explicitly requested, while preserving hard `.git`/`node_modules` traversal exclusions and unconditional secret exclusions. Coordinate with TS-07 before widening traversal.

**Acceptance:** a harmless ignored nested text file is found with includeIgnored=true and absent by default; protected/dependency/metadata paths remain excluded; ordinary glob filtering still works.

## TS-03 — An empty pagination cursor returns an empty repository

**Priority:** P2 · **Evidence:** reproduced in this review and with walkDir · **Confidence:** high.

**Locations:** `src/utils/fs.ts:36-42`, `src/utils/fs.ts:93-95`, `src/llm/hazeTools.ts:53`.

An empty cursor produces no segments, but `collecting` is false because the value is not null. The pre-cursor branch returns without emitting entries. `listFiles({path: '.', cursor: ''})` therefore reports an empty listing with truncated=false even in this populated checkout. This is particularly easy for model callers with optional fields materialized as empty strings.

**Smallest fix:** normalize empty cursors to absent at the boundary, or reject them with a recoverable structured argument error. Do not silently present an empty tree.

**Acceptance:** absent/empty cursor behavior, first page, valid continuation, stale cursor, and recursive directory cursor tests in `tests/utils/walkDir.test.ts` and `tests/hazeTools/listFiles.test.ts`.

## TS-04 — Regex replacement reruns the pattern without its original context

**Priority:** P2 · **Evidence:** source-traced, deterministic expression · **Confidence:** high.

**Locations:** `src/llm/tools/replaceInFiles.ts:38-48`.

Matches are found in the complete file, but replacement expansion reruns the regex against `match[0]` alone. For content `prefix foo`, pattern `(?<=prefix )foo`, replacement `bar`, the initial match is `foo`; rerunning the lookbehind on `foo` finds nothing, so the preview/application keeps `foo`. Lookahead and replacement tokens referring to surrounding input have analogous issues. A reported occurrence need not actually be replaced.

**Smallest fix:** derive the replacement from the original match and original input context, using native replacement semantics where possible. Define/document supported replacement tokens rather than hand-implementing an incomplete generic regex engine.

**Acceptance:** ordinary captures, named captures if supported, lookbehind/lookahead, multiline anchors, literal dollar signs, and selected occurrence IDs produce the same replacements as the documented native semantics.

## TS-05 — Malformed LSP ranges can silently corrupt edits

**Priority:** P1 · **Evidence:** reproduced with pure helpers · **Confidence:** high.

**Locations:** `src/llm/lsp/workspaceEdit.ts:12-20`, `src/llm/lsp/workspaceEdit.ts:39-53`, `tests/llm/lsp/workspaceEdit.test.ts:5-24`.

Range coordinates are coerced with Number rather than validated. Missing coordinates become NaN, and JavaScript slice coerces those offsets to zero. A malformed edit with empty start/end objects inserts text at the beginning of the file instead of being rejected. Negative, reversed, fractional, and out-of-document ranges also lack a complete validation boundary. Server output is untrusted protocol data even when the server is locally configured.

**Smallest fix:** validate finite integer positions and ordering before calculating offsets; reject malformed edits as a whole before any write. Preserve the documented LSP behavior for character offsets beyond line length where applicable. Bound document/aggregate edit input before reading whole files.

**Acceptance:** invalid and reversed ranges do not mutate files; valid UTF-16 and CRLF edits work; mixed valid/invalid multi-file responses fail before the first write. Current tests cover valid coordinates and overlap, not this malformed-input path.

## TS-06 — Command-specific reducers reinterpret unrelated compound output

**Priority:** P2 · **Evidence:** observed and reproduced · **Confidence:** high.

**Locations:** `src/core/shellOutput/reducers/git.ts:3-26`, `src/core/shellOutput/reducers/git.ts:34-63`, `src/core/shellOutput/registry.ts:83-89`.

The Git reducer selects a Git subcommand found inside a compound command, then parses the entire combined output as that subcommand's output. In this review, `pwd && git status --short && ls -la` lost the working-directory/file listing and became `git status: 0 changed, 0 untracked`. Raw handles allow recovery, but the default semantic summary is misleading and costs extra calls. The same parser can recognize text inside scripts rather than the actual executable command.

**Smallest fix:** apply semantic reducers only when the command shape and output ownership are unambiguous; otherwise use the bounded generic fallback. Do not attempt to split unlabeled stdout retrospectively.

**Acceptance:** mixed command lists, heredocs containing command text, flags, stderr-only failures, and single Git commands. Unknown content must not become a clean-status claim.

## TS-07 — grep traversal exclusions are weaker than targeted-read protection

**Priority:** P1 · **Evidence:** source-traced · **Confidence:** high for policy mismatch; exploit paths not executed.

**Locations:** `src/core/safety/secretPaths.ts:28-49`, `src/core/safety/secretPaths.ts:83-102`, `src/core/safety/secretPaths.ts:114-121`, `src/llm/hazeTools.ts:194-219`.

The targeted-read predicate lowercases names and protects home credential directories/files. grep validates only the root and uses a smaller, case-sensitive glob list for descendants. A user-blessed ancestor plus a positive glob can enable traversal of protected home-store descendants whose names are absent from the exclusion list. Uppercase variants of protected basenames also diverge from the targeted predicate. Returned matches are not individually revalidated.

**Smallest fix:** derive traversal exclusions and targeted predicates from shared policy data, accounting for case and protected directory subtrees. Reject before content collection rather than filtering already-read secrets out of results. Coordinate with TS-02.

**Acceptance:** mocked argument/traversal tests prove case-insensitive basename protection, protected home subtrees, positive user globs, and explicit ignore overrides. No real home-store reads are needed.

## TS-08 — Multi-file apply lacks a truthful partial-failure contract

**Priority:** P2 · **Type:** concrete reliability risk · **Evidence:** source-traced.

**Locations:** `src/llm/tools/replaceInFiles.ts:103-113`, `src/llm/lsp/workspaceEdit.ts:59-75`.

Both helpers preflight and then write files sequentially. If a later write fails (permissions, disk full, concurrent filesystem change), earlier files stay changed while the tool rejects instead of returning a bounded list of completed mutations. No transaction/rollback is provided. AR-02 compounds this because failed calls cannot currently account for partial mutation debt.

**Smallest fix:** first make partial effects explicit in structured failures and completion evidence. Stage writes or best-effort rollback only if the desired public contract requires all-or-nothing; do not introduce a database-style transaction framework. Never roll back over independently changed user content.

**Acceptance:** inject failure on the second file and verify exact changed/unchanged paths, recovery hints, and validation debt. If rollback is implemented, also fail rollback and preserve truthful evidence.
