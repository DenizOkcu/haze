# Feature Specification: /fleet — Parallel Subagent Orchestration

**Feature Branch**: `001-fleet-subagents`  
**Created**: 2026-07-09  
**Status**: Draft  
**Input**: User description: "add a new slash command /fleet which takes the following prompt and analyzes it if this is parallelizable and then starts subagents for each parallelizable task"

## Clarifications

### Session 2026-07-09

- Q: How should `/fleet` keep parallel file-modifying subagents safe from conflicting edits? → A: Per-file write guard — subagents may write any file, but concurrent edits to the same file are serialized and conflicts are surfaced, never silently lost.
- Q: When `/fleet` decides a prompt is not parallelizable, what happens next? → A: Inform only — report it is not parallelizable and stop; the system does not auto-execute it as a normal turn. The user re-submits via the normal path.
- Q: Should the aggregated `/fleet` result become part of the conversation context? → A: Yes — inject the aggregated result into the conversation so the model can act on it in subsequent turns; results persist in the session, not display-only.
- Q: What default maximum number of concurrent subagents should `/fleet` use? → A: 5 concurrent subagents (the shipped default), balancing parallelism against rate-limit safety and cost.
- Q: What level of live progress should the user see during a `/fleet` run? → A: Per-subtask status — each subtask shows running/done/failed, updated as it finishes; no live token streaming (full results shown in the aggregated view on completion).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Parallelize a Multi-Part Prompt (Priority: P1)

A user has a request that naturally splits into several independent pieces of work — for example, "research how library X handles retries, audit the error handling in our auth module, and draft migration notes for the v2 upgrade." The user types `/fleet <that prompt>`. The system analyzes the prompt, recognizes it decomposes into multiple independent tasks, fans out one subagent per task so they run concurrently, and returns a consolidated set of results.

**Why this priority**: This is the core value of the feature — turning a single request into faster, parallel execution. Without it, the feature has no reason to exist.

**Independent Test**: Type `/fleet <prompt>` with a prompt containing 2+ clearly independent tasks and observe that the system identifies the subtasks, launches them concurrently, and presents their combined outcomes. The test succeeds even with no other story implemented.

**Acceptance Scenarios**:

1. **Given** a prompt that contains three mutually independent tasks, **When** the user runs `/fleet <prompt>`, **Then** the system decomposes it into three subtasks and runs one subagent per subtask concurrently, and presents a consolidated summary of all three results.
2. **Given** a successfully completed `/fleet` run, **When** the results are reviewed, **Then** every spawned subtask's outcome (summary and status) is visible to the user in a single consolidated view.
3. **Given** a parallel `/fleet` run, **When** it executes, **Then** the user can see the decomposition plan (the list of identified subtasks) that was acted on.
4. **Given** a completed `/fleet` run whose aggregated result was injected into the conversation, **When** the user asks a follow-up question about the results, **Then** the model can answer without the user re-pasting the results.

---

### User Story 2 - Graceful Handling of Non-Parallelizable Prompts (Priority: P2)

A user types `/fleet <prompt>` with something that is a single, sequential, or tightly interdependent task — for example, "refactor this function and then update its callers step by step." The system analyzes the prompt, determines it does not decompose into genuinely independent parallel tasks, and clearly informs the user that the prompt is not a good fit for parallel execution rather than spawning redundant or competing subagents.

**Why this priority**: Correctly declining to parallelize protects the user from wasted effort, incorrect results, and wasted resources. It is the feature's integrity guardrail.

**Independent Test**: Type `/fleet <prompt>` with an obviously sequential/dependent prompt and verify the system reports it as non-parallelizable and does not fan out subagents.

**Acceptance Scenarios**:

1. **Given** a prompt that is a single atomic task, **When** the user runs `/fleet <prompt>`, **Then** the system informs the user that the prompt is not parallelizable and does not spawn multiple subagents.
2. **Given** a prompt whose subtasks are heavily dependent on one another, **When** analyzed, **Then** the system treats it as non-parallelizable and reports why (dependency between parts) to the user.

---

### User Story 3 - Visibility and Control During Parallel Runs (Priority: P3)

While a `/fleet` run is executing, the user can see that parallel work is in progress and can abort it. Aborting stops every in-flight subagent cleanly and returns control to the user without leaving the session in a broken state.

**Why this priority**: Long-running parallel work needs progress feedback and a reliable escape hatch; without abort, a runaway run cannot be stopped.

**Independent Test**: Start a `/fleet` run on a multi-task prompt, confirm progress is visible while it runs, then abort and confirm all subagents stop and control returns to the user.

**Acceptance Scenarios**:

1. **Given** a `/fleet` run with multiple subagents in flight, **When** the user aborts, **Then** all in-flight subagents stop and the user regains control of the session.
2. **Given** a `/fleet` run is executing, **When** the user observes the screen, **Then** each subtask's status (running / done / failed) is shown and updated as it finishes, without live per-subagent token streaming.

---

### User Story 4 - Robustness Across Mixed and Failing Subtasks (Priority: P4)

A `/fleet` run may contain a mix of independent and dependent work, or one subtask may fail or time out while others succeed. The system isolates failures so that one bad subtask does not collapse the whole run, and it surfaces per-subtask status so the user knows what succeeded and what did not.

**Why this priority**: Real prompts are messy; partial-success handling makes the feature trustworthy for everyday use.

**Independent Test**: Run `/fleet` on a prompt where one subtask is designed to fail (e.g., references a non-existent file) and confirm the other subtasks still complete and the failure is reported per-subtask.

**Acceptance Scenarios**:

1. **Given** a prompt where one independent subtask fails, **When** the `/fleet` run completes, **Then** the failing subtask's status is reported as failed while the other subtasks' successful results are still presented.
2. **Given** a prompt that contains both parallelizable and dependent parts, **When** analyzed, **Then** the system parallelizes only the independent parts and clearly reports the dependent part(s) as not parallelized.
3. **Given** two parallel subagents that both edit the same file, **When** they run concurrently, **Then** the edits are serialized and any conflict is surfaced to the user rather than silently clobbered.

---

### Edge Cases

- **Empty or whitespace-only prompt**: `/fleet` with no prompt or only whitespace is rejected with a clear message; no analysis or subagents run.
- **More parallelizable tasks than the concurrency cap (default 5)**: The system never spawns an unbounded number of subagents; it applies the cap and either caps or schedules within the bound, and informs the user how many tasks were acted on.
- **Concurrent edits to the same file**: When two parallel subagents target the same file, the edits are serialized and any conflict is surfaced to the user; edits are never silently lost.
- **Ambiguous prompt": When the prompt could reasonably be parallel or sequential, the system makes a best-effort decision and communicates its reasoning so the user can rephrase if needed.
- **Subagent produces no usable output**: A subtask that returns empty/no text is reported as "no output" rather than appearing to succeed silently.
- **Abort during analysis (before fan-out)**: Aborting while the prompt is still being analyzed stops the run cleanly with no subagents spawned.
- **Very large/long prompt**: Extremely long prompts are handled within the same bounded-output expectations as normal prompts without crashing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a `/fleet` command that accepts a natural-language prompt as its argument.
- **FR-002**: The system MUST analyze the provided prompt to determine whether it can be decomposed into two or more genuinely independent, parallelizable tasks.
- **FR-003**: When the prompt is parallelizable, the system MUST decompose it into distinct independent subtasks and run one subagent per subtask concurrently.
- **FR-004**: When the prompt is not parallelizable (a single task or tasks with strong interdependencies), the system MUST inform the user, MUST NOT spawn redundant/competing subagents, and MUST NOT automatically execute the prompt as a normal turn — the user re-submits via the normal path if they want it run.
- **FR-005**: The system MUST surface the decomposition decision and the list of subtasks it acted on (or, if declined, why) to the user.
- **FR-006**: The system MUST cap the maximum number of concurrent subagents to a safe bound — default 5 — to prevent runaway resource usage; subtasks beyond the cap MUST be queued/capped (never spawned unbounded) and the user informed how many ran.
- **FR-007**: The system MUST aggregate the results/summaries from all spawned subagents, present them in a single consolidated view to the user, and inject that aggregated result into the conversation context so it is available to the model in subsequent turns.
- **FR-008**: The system MUST allow the user to abort the parallel execution; an abort MUST stop all in-flight subagents and restore user control.
- **FR-009**: A failure, timeout, or empty output in one subtask MUST NOT cause the whole `/fleet` run to fail; each subtask's status MUST be reported individually.
- **FR-010**: Each subagent MUST operate independently with no shared conversation history, consistent with the product's existing subagent behavior.
- **FR-011**: The `/fleet` command MUST fit into the existing slash-command surface and help/listing so users can discover it.
- **FR-012**: The system MUST guard concurrent file modifications: when two or more subagents attempt to edit the same file during a `/fleet` run, those edits MUST be serialized and any conflict MUST be surfaced to the user rather than silently overwriting earlier edits.
- **FR-013**: During a `/fleet` run, the system MUST show per-subtask status (running / done / failed), updated as each subtask finishes; it MUST NOT stream each subagent's tokens live in parallel. Full results are presented in the aggregated view on completion.

### Key Entities *(include if feature involves data)*

- **Fleet Prompt**: The natural-language instruction the user passes to `/fleet`. The single input to the feature.
- **Decomposition**: The system-generated analysis of a Fleet Prompt: a parallelizable flag plus, when parallelizable, the ordered list of independent subtasks. When not parallelizable, a reason.
- **Subtask**: A single independent unit of work derived from a Decomposition, assigned to exactly one subagent. Has a description and a status outcome.
- **Subtask Result**: The outcome of one subtask — its status (succeeded / failed / timed out / cancelled / no-output), a summary, and any evidence produced.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can complete a multi-part parallelizable request via `/fleet` in less wall-clock time than running the same parts one after another in a normal turn.
- **SC-002**: The system correctly identifies non-parallelizable prompts in the majority of cases and declines to fan out, so users are not presented with redundant competing results.
- **SC-003**: Every subtask spawned by a `/fleet` run has its outcome visible to the user (status + summary) with no silent subtasks.
- **SC-004**: A user can abort an in-flight `/fleet` run and regain control within a short, perceptible window, with no subagents left running afterward.
- **SC-005**: A single failing subtask does not prevent the remaining independent subtasks from completing and being reported.

## Assumptions

- **Autonomous execution by default**: Per the "analyze then start" wording, `/fleet` analyzes the prompt and immediately executes the parallel plan without a manual confirmation step. (A future iteration could add an optional review/confirm mode, but that is out of scope here.)
- **Reuses the existing subagent capability**: Subagents spawned by `/fleet` follow the product's existing subagent behavior — independent context, a fixed set of allowed tools, bounded step/tool budgets, and a compact summary back to the caller.
- **Same configured model**: The analysis step and the spawned subagents use the user's currently configured provider/model; no separate or hidden model is introduced.
- **Bounded concurrency**: A maximum of 5 concurrent subagents runs by default, balancing parallelism against rate-limit safety and cost. The cap may be tuned, but 5 is the shipped default.
- **Non-parallelizable = inform only, not auto-execute**: When a prompt is not parallelizable, the system informs the user and stops; it does not automatically run the prompt as a normal turn or force an artificial fan-out. The user re-submits via the normal path if they want the work done.
- **Scope**: This feature is the `/fleet` command and its analyze→fan-out→aggregate flow. It does not change the existing model-facing subagent tool or how normal (non-`/fleet`) turns behave.
