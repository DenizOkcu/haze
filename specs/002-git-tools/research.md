# Research: Dedicated Git Tools

## Decisions

- **Decision**: Implement git operations as built-in AI SDK tools in a new `src/llm/tools/gitTools.ts`, registered in `src/llm/hazeTools.ts`, executing `git` through the shared bounded subprocess primitive (`core/process`, `runBoundedProcess`) — the same primitive used by `shellTool.ts`/`grepRunner.ts`.
  - **Rationale**: reuses the existing byte-bounded collection, timeout/abort process-tree teardown, and structured metadata; keeps git execution consistent with the rest of the tool layer. Tool-level execution (rather than shell) is what enables compact structured results and steering.
  - **Alternatives considered**: shelling out only (rejected — verbose raw output, the problem being fixed); a git library (rejected — new dependency, and bounded CLI output shaping is already solved by `core/process`).

- **Decision**: Tool surface = one `git` tool with a `command` enum, or a small set of named tools (`gitStatus`, `gitLog`, `gitDiff`, `gitBranch`, plus mutating ops)? → small set of named tools grouped under a `gitTools` export (e.g. `gitStatus`, `gitLog`, `gitDiff`, `gitBranch`, `gitStage`, `gitCommit`, `gitBranchManage`, `gitRebase`, `gitReset`).
  - **Rationale**: named tools give the model explicit, self-describing schemas and make the system-prompt steering rule trivial ("use the git* tools, not shell git"); an enum forces the model to construct command strings, which is closer to shell habits.
  - **Alternatives considered**: single `git` tool with subcommand enum (rejected — harder to steer against, larger schema).

- **Decision**: Bounded defaults of ~20 commits for log and ~200 diff lines, with `limit`/`path`/`range` parameters to narrow or extend; truncation always marked.
  - **Rationale**: set by clarification (Session 2026-11-20); matches the minimal-token goal while keeping results complete enough to act on.
  - **Alternatives considered**: 5/50 (too lossy), 100/1000 (defeats the token goal).

- **Decision**: Steering lives in `src/llm/systemPrompt.ts` standing guidance (e.g. "Use the dedicated git* tools for git operations instead of running git via shell; shell git only when the user explicitly asks for a raw command or a case the tools don't cover"), kept concise per `src/llm/AGENTS.md` prompt-sync rules.
  - **Rationale**: clarification established system guidance as the steering mechanism; tool descriptions reinforce it at call time.
  - **Alternatives considered**: settings toggle (rejected — YAGNI, no user-facing knob requested).

- **Decision**: Safety inheritance — git tools operate only in the workspace repository (resolve and confine the repo root to the workspace), refuse when cwd is not a git repo with a clear `not_a_repository` result, and never read git internals (`config`/`credentials`/hooks) or secret files; mutating operations require the user's explicit request for destructive/history-rewriting actions (constitution Principle I: no confirmation gates, explicit request suffices).
  - **Rationale**: aligns with existing `core/safety` invariants and the expert-oriented constitution.
  - **Alternatives considered**: allowing outside-repo paths (rejected — violates FR-005).
