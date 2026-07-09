# src/llm/tools/AGENTS.md

Last updated: 2026-07-09.

Implementation helpers for Haze built-in tools.

## Shared filesystem/path rules

- Use `workspaceFile.ts` and `utils/path.ts` helpers for every workspace path. Do not manually join unchecked user paths to cwd.
- Respect `.gitignore` by default. Only honor ignored paths when the tool input explicitly allows it.
- Keep path values in results workspace-relative and stable for model/UI consumption.
- Mutating helpers must call scoped-context mutation checks before writing.

## Turn-scoped tool context

`toolContext.ts` owns per-turn execution state on AI SDK tool `context` values:

- Deduplicates identical read-only tool calls until a mutation epoch changes.
- Deduplicates identical in-flight calls.
- Prevents concurrent mutations of the same path.
- Tracks failed mutations and forces a fresh `readFile` before retry.
- Lazily discovers nested `CLAUDE.md`/`AGENTS.md` instructions for touched subtrees.
- Tracks loaded context-file signatures, serializes concurrent scoped discovery, queues newly discovered scoped files in `pendingContextFiles`, and notifies the UI when instruction files are read.

Do not persist this state; it is valid only for one agent turn. If scoped context behavior changes, keep `config/contextFiles.ts`, `streaming.ts`, and tool-result tests aligned.

## Editing helpers

- `editMatch.ts` implements unique exact replacements with tolerances for readFile line prefixes and trailing-whitespace-only differences when still unique.
- Multiple replacements in one file should be one `editFile` call; overlapping edits must be rejected.
- `replaceLines` is the recovery path when exact text is stale or ambiguous.
- Diff output should be compact and line-limited by `INLINE_DIFF_LINE_LIMIT`.

## Bash/fetch/output helpers

Current behavior:

- `bashTool.ts` always executes commands and returns informational risk classification; `allowMutation` is compatibility-only and should not affect behavior.
- Fetch helpers must cap by bytes, not characters, and preserve valid UTF-8 prefixes when truncating.

- `bashTool.ts` runs `bash -lc`, classifies commands, parses validation output, reduces stdout/stderr, stores raw handles where needed, and returns structured metadata.
- `fetchTool.ts` enforces URL safety through `webFetch.ts`/URL guard and caps returned content.
- `outputCap.ts` and `storedOutputTool.ts` keep large direct outputs retrievable without bloating context.
- `grepParse.ts` parses ripgrep JSON; prefer structured matches over plain text.

## Failure results

- Use `HazeToolError` and `structuredToolFailure` for recoverable/actionable failures.
- Include `reasonCode`, `recoverable`, and `suggestedNextStep` when the model can retry safely.
- Avoid throwing raw filesystem/process errors directly to tool output.

## Tests

Most behavior here is covered by `tests/hazeTools/**` plus focused `tests/llm/**` tests. Add regression tests for every new edge case in editing, path safety, output capping, or deduplication.
