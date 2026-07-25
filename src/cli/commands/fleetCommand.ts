import type {CommandContext, CommandResult} from './commands.js';

/**
 * Behavioral guidance for the native `/fleet` command.
 *
 * `/fleet` is a model-driven orchestration command: it analyzes a prompt for
 * independent tasks and, when parallelizable, fans out bounded waves of
 * `subagent` tool calls (at most 5 in flight at a time) until all tasks are
 * done, then aggregates the results. The heavy lifting (parallel spawn,
 * per-worker bounds, abort propagation, partial-failure isolation) is provided
 * by the existing `subagent` tool; this guidance steers the model's
 * decomposition, fan-out, and aggregation discipline.
 */
const FLEET_GUIDANCE = `You are running the /fleet command — parallel subagent orchestration.

Why this exists: each subagent works in its own, separate context and returns only a concise result. Its intermediate reads, searches, and tool calls never enter the main conversation — only its final summary does — and once it returns, that working context is discarded. So /fleet keeps the main context lean AND lets independent work proceed in parallel. It is worthwhile even for just two tasks; do not pad to a fixed number.

Apply the following flow to the user's prompt, in order, using the built-in subagent tool.

1. Empty prompt guard
   If the prompt is empty or whitespace-only, ask the user for a prompt and STOP. Do not analyze or fan out.

2. Analyze for parallelism and decompose
   Decide whether the prompt decomposes into two or more genuinely independent tasks — tasks whose outcomes do not depend on each other. State that decision and a brief reason out loud before acting. Decompose along the prompt's natural independent axes (distinct deliverables, distinct features, distinct bugs) rather than geographic file-slices.
   - Parallelizable → enumerate the subtasks. Use whatever number of genuinely independent tasks the prompt naturally yields — two is fine, seven is fine. Do not pad to a fixed count, and do not artificially cap the total.
   - Not parallelizable (a single task, or strong interdependencies) → tell the user it is not parallelizable, give the reason, and STOP. Do NOT auto-run the prompt as a normal turn; the user can re-submit it normally if they want it done.
   - Mixed (some independent parts, some dependent parts) → parallelize only the independent parts, and explicitly report the dependent part(s) as NOT parallelized with the reason.

3. Assign disjoint WRITES (reads may overlap)
   Two concurrent subagents may freely READ the same files — read overlap is safe (this is why review-type decompositions are fine). They must never EDIT or WRITE the same file concurrently, because concurrent writes to one file clobber each other. So: give each subtask a disjoint set of files to MUTATE. If two tasks must edit the same file, merge them into one subagent or run them sequentially — never let two concurrent subagents write the same file.

4. Fan out with bounded concurrency (at most 5 in flight; run everything in waves)
   Show the user the full list of subtasks you will run (the decomposition plan), including how many tasks there are. Then run them with at most 5 subagents IN FLIGHT at a time:
   - Spawn the first min(N, 5) subagent tool calls in a single step so they run concurrently.
   - When that wave returns, spawn the next min(remaining, 5) in the next step. Repeat until every subtask has run. Never drop or skip tasks because there are more than 5 — queue the rest and run them in successive waves.
   - Keep wave narration minimal. If every task fits in one wave (N ≤ 5), just fan out right after showing the decomposition plan — do NOT add a restating line like "Running all N in one wave (N ≤ 5)" or "N tasks ≤ 5 in flight → one wave"; the plan already states the count, so repeating the wave math is noise. Only mention waves when there is more than one, and then keep it to a single short line.
   - Each subagent call is fully independent, has no conversation history, and runs under a bounded step/tool budget. Write every subagent task so it can succeed on its own AND so its final message is the deliverable:
     · Required output: state exactly what the subagent must produce and in what format (e.g. "End your turn with a findings list: per item — severity, file:line, issue, suggested fix.").
     · Final message = the result: tell the subagent its last message IS the deliverable — it must NOT end by narrating its reading or working process ("I'll read…", "Now let me…"). Process narration as the final answer is a failure.
     · Budget awareness: tell the subagent its budget is bounded — sample strategically instead of reading every file end-to-end, and reserve its final step to synthesize. If it cannot cover everything, it must report what it reviewed and what it did not (a stated coverage gap is acceptable; silently running out of budget is not).
     · Project context: subagents run in their own context but already inherit project instructions (AGENTS.md/CLAUDE.md) and pick up subtree-specific instructions for the files they touch — so point a subagent at "follow the AGENTS.md for this area" rather than restating those rules inline.
     · Keep the task crisp and self-contained, with no reference to this conversation.
   - Scope each subtask to fit the budget. If a slice is too large (e.g. dozens of files), split it finer, or instruct the subagent to prioritize the highest-value parts and explicitly report what it skipped — never hand a subagent more work than it can finish and synthesize.

5. Aggregate the results
   After all subagents return (across all waves), aggregate their summaries into one consolidated answer, giving for each subtask: its status (done / failed / timed out / no output) and a concise summary of what it found or changed. Because only these summaries enter the main context (not each subagent's internal work), the conversation stays lean.
   - Isolate failures. A failing, timed-out, or empty-output subagent must not abort the whole run — report every subtask's status individually.
   - No silent successes. Explicitly mark a subagent that produced no usable output as "no output" rather than presenting it as a success.
   - This consolidated answer is part of the conversation, so the user can ask follow-up questions about the results without re-pasting them.

Rules at a glance
   - Fan out for context isolation + parallelism — worthwhile even for two tasks; use the natural number of independent tasks (2..N).
   - At most 5 subagents in flight at a time; run the rest in waves until all are done. Never drop tasks.
   - Reads may overlap across subagents; writes must be disjoint (merge or sequence same-file writes).
   - Each subagent's final message must be its deliverable — no process narration.
   - Never auto-run a non-parallelizable prompt — inform the user and stop.
   - Never silently drop a failed or empty subtask — always report its status.`;

export function buildFleetPrompt(args: string): string {
  return `${FLEET_GUIDANCE}

---

The user ran /fleet with the prompt below. Apply the flow above to it.

User prompt:
${args}`;
}

export async function handleFleetCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const prompt = args.trim();
  if (!prompt) {
    ctx.addSystemMessage('/fleet needs a prompt describing the work to parallelize. Usage: /fleet <prompt>');
    return 'handled';
  }
  await ctx.runAgentTurn(buildFleetPrompt(prompt), `/fleet ${prompt}`);
  return 'handled';
}
