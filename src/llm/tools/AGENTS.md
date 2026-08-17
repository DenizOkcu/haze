# src/llm/tools/AGENTS.md

Last updated: 2026-08-17 for the 1.0.0 release.

Implementation helpers for haze built-in tools.

## Shared filesystem/path rules

- Use `workspaceFile.ts` and `utils/path.ts` helpers for every workspace path. Do not manually join unchecked user paths to cwd.
- Respect `.gitignore` by default. Only honor ignored paths when the tool input explicitly allows it.
- Keep path values in results workspace-relative and stable for model/UI consumption.
- Mutating helpers must call scoped-context mutation checks before writing.
- Read helpers (`prepareWorkspaceRead`) honour the turn-scoped bless set: paths the user mentioned in the prompt may be read outside the workspace and bypass `.gitignore`. Mutating helpers (`prepareWorkspaceMutation`, `prepareWorkspaceWritePath`) never consult the bless set — confinement is absolute for edits/writes.
- Secret files (`core/safety/secretPaths.ts`: SSH keys, shell histories, `.env`/`.envrc`, `*.pem`/`*.key`, home credential stores) are refused for reads and mutations alike, before any filesystem access, with both lexical and real path checks. This overrides the bless set and `allowIgnored`. `grep` appends `secretSearchExcludeGlobs()` after any model glob (later ripgrep globs win; positive re-include globs would whitelist the search, so exclusions stay negated-only). The `shell` tool is deliberately not hard-filtered; shell-side avoidance is instructed by `SECRET_FILE_RULE` in `llm/systemPrompt.ts`.

## Turn-scoped tool context

`toolContext.ts` owns per-turn execution state on AI SDK tool `context` values:

- Deduplicates identical read-only tool calls until a mutation epoch changes.
- Deduplicates identical in-flight calls.
- Prevents concurrent mutations of the same path.
- Tracks only mutation failures that explicitly request `recoveryTool: 'readFile'` and forces a fresh read before retrying those paths. Argument-only failures remain directly retryable. Path state uses normalized lexical workspace identity so aliases such as `a.ts` and `./a.ts` agree.
- Lazily discovers nested `CLAUDE.md`/`AGENTS.md` instructions for touched subtrees.
- Tracks loaded context-file signatures, serializes concurrent scoped discovery, queues newly discovered scoped files in `pendingContextFiles`, and notifies the UI when instruction files are read.
- Carries the turn-scoped workspace mutation policy/owner. File mutations and shell calls acquire it; worker owners are reentrant so a whole-worker lease cannot deadlock its internal tools. Shell coordination is conservative and is not a sandbox.
- Validates the runtime types of every known optional context field while allowing unknown future fields for compatibility.

Do not persist this state; it is valid only for one agent turn. If scoped context behavior changes, keep `config/contextFiles.ts`, `streaming.ts`, and tool-result tests aligned.

## Editing helpers

- `editMatch.ts` implements unique exact replacements with tolerances for readFile line prefixes and trailing-whitespace-only differences when still unique.
- Multiple replacements in one file should be one `editFile` call; overlapping edits must be rejected.
- `replaceLines` is the recovery path when exact text is stale or ambiguous.
- Diff output should be compact and line-limited by `INLINE_DIFF_LINE_LIMIT`.

## Shell/fetch/output helpers

Current behavior:

- `shellTool.ts` always executes commands and returns informational risk classification (secret-file protection is not hard-enforced in shell; it is instructed via `SECRET_FILE_RULE` in the system prompt). Known test/build commands are validation automatically; `purpose=validation` gives custom assertion commands structured pass/fail evidence from their real process result.
- Fetch helpers must cap by bytes, not characters, and preserve valid UTF-8 prefixes when truncating.

- `shellTool.ts` runs the configured user login shell through the shared bounded subprocess primitive (`core/process`): stdout/stderr are byte-bounded during collection, timeout/abort terminate the process tree, it classifies commands, parses validation output, reduces output, stores raw handles where needed, and returns structured metadata including `aborted`/`signal`/`forcedTermination`. Its schema identifies the active dialect. With `background=true`, it instead registers a main-turn-only long-running process and returns immediately.
- `processTool.ts` is the single control surface for listing, reading, and killing registered background processes. Output remains accessible through the same `readToolOutput` handle path; do not expose background spawning to fleet workers.
- `fetchTool.ts` enforces URL safety through `webFetch.ts`/URL guard and caps returned content.
- `outputCap.ts` and `storedOutputTool.ts` keep large direct outputs retrievable without bloating context.
- `grepRunner.ts` runs ripgrep on the shared `runBoundedProcess` primitive (CR-004) and parses `--json` incrementally via its stdout interceptor, stopping at the true global match cap; do not route grep through an unbounded buffer.
- `gitIgnore.ts` evaluates `.gitignore` and `.git/info/exclude` rules in-process without requiring Git. It discovers parent repository boundaries and linked-worktree git directories, preserves POSIX backslash names, and caches rule files by mtime and size for one listing operation. Reads fail open when a rule source is unreadable; mutation guards report `unknown` and fail closed (F-05).

## Failure results

- Use `HazeToolError` and `structuredToolFailure` for recoverable/actionable failures.
- Include `reasonCode`, `recoverable`, and `suggestedNextStep` when the model can retry safely.
- A `HazeToolError` may carry its own `suggestedNextStep` and `recoverable` (the error wins over the caller's generic hint); terminal refusals such as `secret_file_protected` use `recoverable: false` so the model does not burn steps retrying.
- Avoid throwing raw filesystem/process errors directly to tool output.

## Tests

Most behavior here is covered by `tests/hazeTools/**` plus focused `tests/llm/**` tests. Add regression tests for every new edge case in editing, path safety, output capping, or deduplication.
