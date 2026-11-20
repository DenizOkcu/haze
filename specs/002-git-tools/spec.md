# Feature Specification: Dedicated Git Tools

**Feature Branch**: `002-git-tools`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "add git tools with a focus on minimal tokens for git commands but giving the repo all necessary information. guide the model to use the git tools instead of using git via shell"

## Clarifications

### Session 2026-11-20

- Q: Should the dedicated git tools cover only read-only queries (status, log, diff, branch), or must they also cover mutating operations like staging and committing? → A: Full git coverage, including mutating operations such as stage, commit, branch, rebase, and reset, via the dedicated tools.
- Q: What default output bounds should git history and diff results use before truncating (e.g., how many commits and how many diff lines by default)? → A: Moderate defaults of about 20 commits for history and about 200 diff lines per result, with explicit limit/path/range parameters to narrow or extend.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read repository state without token-heavy shell output (Priority: P1)

As a user working with an agent in a git repository, I want the agent to inspect git state (status, log, diff, branches) through dedicated purpose-built git operations, so that repository information arrives compact and complete instead of as verbose raw command output that wastes context tokens.

**Why this priority**: Every coding session needs repository context; shrinking the token cost of gathering it benefits every turn and directly addresses the core request.

**Independent Test**: Ask the agent "what changed in this repo?" in a repository with uncommitted changes and recent commits; verify the answer is accurate and produced without dumping full raw `git status`/`git log` output into the conversation.

**Acceptance Scenarios**:

1. **Given** a repository with uncommitted modifications, **When** the agent needs the working-tree state, **Then** it obtains a concise, complete summary (changed files, staged/unstaged split, branch) via a git operation, not a shell command.
2. **Given** a repository with commit history, **When** the agent needs recent history, **Then** it receives a bounded, summarized history (hash, subject, author, relative time) rather than full verbose log output.
3. **Given** a file with changes, **When** the agent needs to see them, **Then** it receives a focused diff with bounded size instead of an unbounded raw diff.

---

### User Story 2 - Model prefers git tools over shell for git (Priority: P1)

As a user, I want the agent to be guided to use the dedicated git tools instead of running `git` through the shell, so that git work is token-efficient, consistent, and safe by default.

**Why this priority**: Tools alone don't change behavior; without explicit guidance the model keeps shelling out to git and the token savings never materialize.

**Independent Test**: In a fresh session, ask the agent to check the current branch or recent commits; verify it uses a git tool rather than a `git ...` shell invocation.

**Acceptance Scenarios**:

1. **Given** a user request that requires git information, **When** the agent chooses how to fulfill it, **Then** it prefers a dedicated git tool over `git` via the shell.
2. **Given** standing instructions visible to the agent, **When** the agent plans a git-related step, **Then** the instruction to use the git tools instead of shell git is present and followed.

---

### User Story 3 - Safe, bounded git operations (Priority: P2)

As a user, I want git operations to respect repository boundaries and stay bounded, so that asking about git never produces unbounded output or touches repositories outside the current workspace.

**Why this priority**: Compact output is only useful if it is also safe and predictable; unbounded diffs/logs would reintroduce the token problem.

**Independent Test**: Request history or diffs in a repository with a very large log/diff; verify output is truncated/bounded with an indication that more exists.

**Acceptance Scenarios**:

1. **Given** a repository with more history than the output bound, **When** the agent requests the log, **Then** the result is bounded and indicates truncation.
2. **Given** a request referencing a path outside the current workspace repository, **When** the agent attempts a git operation on it, **Then** it is refused rather than executed.

---

### Edge Cases

- What happens when the current directory is not inside a git repository? The git operations should report that clearly instead of failing with a raw git error.
- What happens when a diff or log exceeds the output bound? Output is truncated with a clear marker and a way to request more (e.g., narrower path or range).
- What happens when the user explicitly asks for the raw git command (e.g., debugging)? The shell remains available as an explicit fallback.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The agent MUST have dedicated operations for git queries and actions: working-tree status, recent commit history, diff of changes, branch information, and mutating operations (stage, commit, branch, rebase, reset, and similar).
- **FR-002**: Each git operation MUST return a compact, structured summary containing all information needed to reason about the repository (file lists, commit metadata, change summaries), not raw command output.
- **FR-003**: Git operation output MUST be bounded; by default history is limited to about 20 commits and diffs to about 200 lines, oversized results are truncated with an explicit truncation indicator, and every operation accepts limit/path/range parameters to narrow or extend the result.
- **FR-004**: The agent's standing guidance MUST instruct it to use the dedicated git tools instead of invoking `git` through the shell for routine git queries.
- **FR-005**: Git operations MUST operate only within the current workspace repository; requests outside it are refused with a clear message.
- **FR-006**: When the working directory is not a git repository, git operations MUST return a clear "not a repository" result rather than an opaque error.
- **FR-007**: The shell tool MUST remain available as an explicit fallback when the user asks for a raw git command or a git operation the dedicated tools do not cover.

### Key Entities *(include if feature involves data)*

- **Git status summary**: branch name, ahead/behind vs upstream when available, staged files, unstaged files, untracked files.
- **Commit entry**: abbreviated hash, subject line, author, relative timestamp.
- **Diff summary**: per-file change stats and bounded patch content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Routine git queries (status, log, diff, branch) are answered using dedicated git tools in at least 90% of observed sessions, with shell `git` used only as an explicit fallback.
- **SC-002**: Token cost of obtaining repository status/history is reduced compared to raw shell git output for the same information (compact summaries instead of full command output).
- **SC-003**: Git operation results never exceed their output bound; oversized results are always truncated with an indicator.
- **SC-004**: 100% of git operations requested outside the workspace repository are refused with a clear message; 0% execute against an outside repository.

## Assumptions

- The dedicated git tools cover the full git surface (read-only queries plus mutating operations such as stage, commit, branch, rebase, reset); destructive or history-rewriting operations still require the user's explicit request.
- The agent's standing instructions (system guidance) are the right place to steer tool choice; no separate user-facing setting is needed.
- Bounded, summarized output is preferred over raw output for model consumption; raw git remains available on explicit request.
