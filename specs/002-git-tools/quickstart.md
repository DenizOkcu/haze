# Quickstart: validating the dedicated git tools

Prerequisites: repo checkout with dependencies installed (`npm ci`); run from the repository root, which is itself a git repository.

## Validation scenarios

1. **Status via tool, not shell**
   - Make a small uncommitted change, then ask the agent: "what changed in this repo?"
   - Expected: answer uses `gitStatus` (visible in tool transcript), returns branch + staged/unstaged/untracked lists; no raw `git status` shell output in context.

2. **Bounded history**
   - Ask: "show recent commits"
   - Expected: `gitLog` returns ≤ ~20 entries (hash, subject, author, relative time); on a repo with more history, `truncated` is true with a narrowing hint. Override with `limit`/`range` works.

3. **Bounded diff**
   - Ask: "show the diff for <file>"
   - Expected: `gitDiff` returns per-file stats + patch ≤ ~200 lines by default; oversized diffs are truncated with an indicator.

4. **Steering**
   - In a fresh session, ask for the current branch or recent commits.
   - Expected: the model calls a `git*` tool, not `git` via `shell`. System prompt contains the steering rule (check `src/llm/systemPrompt.ts`).

5. **Refusals**
   - Run haze from a non-git directory: git tools return a clear `not_a_repository` result (no opaque git error).
   - Reference a path outside the workspace: refused with `outside_workspace`.

6. **Shell fallback intact**
   - Explicitly ask for a raw git command (e.g. "run `git log --oneline | head` via shell").
   - Expected: `shell` executes it; FR-007 holds.

## Commands

- Unit/behavior tests: `npx vitest run tests/hazeTools/gitTools.test.ts` (plus `tests/llm/**` prompt-sync tests)
- Full gate before merge: `npm run typecheck && npm test && npm run lint`
- Manual smoke: `npm run dev`, then run scenarios 1–6 above in the interactive CLI
