# src/llm/tools/AGENTS.md

Last updated: 2026-07-10 for the security/correctness remediation (unreleased).

Implementation helpers for haze built-in tools.

## Shared filesystem/path rules

- Use `workspaceFile.ts` and `utils/path.ts` helpers for every workspace path. Do not manually join unchecked user paths to cwd.
- Respect `.gitignore` by default. Only honor ignored paths when the tool input explicitly allows it.
- Keep path values in results workspace-relative and stable for model/UI consumption.
- Mutating helpers must call scoped-context mutation checks before writing.
- Read helpers (`prepareWorkspaceRead`) honour the turn-scoped bless set: paths the user mentioned in the prompt may be read outside the workspace and bypass `.gitignore`. Mutating helpers (`prepareWorkspaceMutation`, `prepareWorkspaceWritePath`) never consult the bless set — confinement is absolute for edits/writes.

## Turn-scoped tool context

`toolContext.ts` owns per-turn execution state on AI SDK tool `context` values:

- Deduplicates identical read-only tool calls until a mutation epoch changes.
- Deduplicates identical in-flight calls.
- Prevents concurrent mutations of the same path.
- Tracks failed mutations and forces a fresh `readFile` before retry.
- Lazily discovers nested `CLAUDE.md`/`AGENTS.md` instructions for touched subtrees.
- Tracks loaded context-file signatures, serializes concurrent scoped discovery, queues newly discovered scoped files in `pendingContextFiles`, and notifies the UI when instruction files are read.
- Carries the turn-scoped workspace mutation policy/owner. File mutations and bash acquire it; worker owners are reentrant so a whole-worker lease cannot deadlock its internal tools. Bash coordination is conservative and is not a sandbox.

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

- `bashTool.ts` runs `bash -lc` through the shared bounded subprocess primitive (`core/process`): stdout/stderr are byte-bounded during collection, timeout/abort terminate the process tree, it classifies commands, parses validation output, reduces output, stores raw handles where needed, and returns structured metadata including `aborted`/`signal`/`forcedTermination`.
- `fetchTool.ts` enforces URL safety through `webFetch.ts`/URL guard and caps returned content.
- `outputCap.ts` and `storedOutputTool.ts` keep large direct outputs retrievable without bloating context.
- `grepRunner.ts` runs ripgrep on the shared `runBoundedProcess` primitive (CR-004) and parses `--json` incrementally via its stdout interceptor, stopping at the true global match cap; do not route grep through an unbounded buffer.

## Failure results

- Use `HazeToolError` and `structuredToolFailure` for recoverable/actionable failures.
- Include `reasonCode`, `recoverable`, and `suggestedNextStep` when the model can retry safely.
- Avoid throwing raw filesystem/process errors directly to tool output.

## Tests

Most behavior here is covered by `tests/hazeTools/**` plus focused `tests/llm/**` tests. Add regression tests for every new edge case in editing, path safety, output capping, or deduplication.
