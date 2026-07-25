import type {CommandContext, CommandResult} from './commands.js';

/**
 * Behavioral guidance for the native `/fleet` command.
 *
 * `/fleet` is a model-driven orchestration command: it analyzes a prompt for
 * independent tasks and, when parallelizable, fans out one `subagent` tool call
 * per task in a single step, then aggregates the results. The heavy lifting
 * (parallel spawn, per-worker bounds, abort propagation, partial-failure
 * isolation) is provided by the existing `subagent` tool; this guidance steers
 * the model's decomposition, fan-out, and aggregation discipline.
 */
const FLEET_GUIDANCE = `You are running the /fleet command — parallel subagent orchestration.

Apply the following flow to the user's prompt, in order, using the built-in subagent tool.

1. Empty prompt guard
   If the prompt is empty or whitespace-only, ask the user for a prompt and STOP. Do not analyze or fan out.

2. Analyze for parallelism
   Decide whether the prompt decomposes into two or more genuinely independent tasks — tasks whose outcomes do not depend on each other and that touch disjoint concerns or files. State that decision and a brief reason out loud before acting.
   - Parallelizable → continue to step 3.
   - Not parallelizable (a single task, or strong interdependencies) → tell the user it is not parallelizable, give the reason, and STOP. Do NOT auto-run the prompt as a normal turn; the user can re-submit it normally if they want it done.
   - Mixed (some independent parts, some dependent parts) → parallelize only the independent parts, and explicitly report the dependent part(s) as NOT parallelized with the reason.

3. Assign disjoint files
   Give each subtask a disjoint set of files to edit or read. If two tasks must touch the same file, either merge them into one subtask or run them sequentially (one after the other) — never let two concurrent subagents edit the same file.

4. Fan out (at most 5 concurrent)
   Enumerate the subtasks you will run and show that list to the user — this is the decomposition plan being acted on. Then spawn exactly one subagent tool call per subtask, all in a single step, so they run concurrently.
   - Cap: at most 5 concurrent subagents. If there are more than 5 independent tasks, prioritize the 5 highest-value ones and tell the user how many were deferred.
   - Each subagent call is fully independent and has no conversation history — give each a clear, self-contained task description so it can succeed on its own.

5. Aggregate the results
   After all subagents return, aggregate their summaries into one consolidated answer, giving for each subtask: its status (done / failed / timed out / no output) and a concise summary of what it found or changed.
   - Isolate failures. A failing, timed-out, or empty-output subagent must not abort the whole run — report every subtask's status individually.
   - No silent successes. Explicitly mark a subtask that produced no usable output as "no output" rather than presenting it as a success.
   - This consolidated answer is part of the conversation, so the user can ask follow-up questions about the results without re-pasting them.

Rules at a glance
   - Never auto-run a non-parallelizable prompt — inform the user and stop.
   - Never spawn more than 5 subagents at once.
   - Never let two concurrent subagents edit the same file — merge or sequence them.
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
