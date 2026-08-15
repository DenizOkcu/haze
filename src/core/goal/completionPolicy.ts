export function toolLoopBudgetPrompt() {
  return 'Tool slice reached for this model step — tools are no longer callable in this turn. Stop attempting to describe or announce tool calls (e.g. "Let me install", "Now I\'ll run", "Let me X"); those phrases imply tool use you cannot perform. Answer once with a bounded progress checkpoint: what is done so far (changes + validation evidence) and, if work remains, the single next concrete unfinished action. haze continues the active goal automatically from that line — do not manufacture a completion summary and do not treat this as the end of the task. Do not repeat yourself, do not loop, do not emit XML/JSON tool-call syntax.';
}

export function repeatedToolCallPrompt(toolNames: string[]) {
  const names = [...new Set(toolNames)].join(', ');
  return `You already called ${names || 'a tool'} with identical input in this turn. Do not call the same tool again with the same arguments. Use the existing tool result already in the conversation, choose a different concrete tool/input if genuinely needed, or give the final/blocked status now.`;
}

/**
 * Ephemeral control appended to continue a response truncated by an
 * output-length finish. Asks the model to resume from where it stopped and
 * complete the requested artifact/answer. One-request nudge only.
 */
export function lengthContinuationPrompt() {
  return 'Your previous response was truncated by the output-token limit before it finished. Continue exactly from where you stopped and complete the requested artifact or answer. Do not repeat what you already produced; finish the in-progress work and then stop.';
}

/**
 * Ephemeral control for the single completion-rescue slice. Only mutation and
 * validation tools are available; discovery must not be reopened. The model gets
 * one tool-bearing step (at most two tool calls) to apply a concrete remaining
 * deliverable you already discovered, then one final tool-free synthesis.
 */
export function completionRescuePrompt() {
  return 'You reached the tool-boundary without a substantive final answer. Only edit/write and validation tools are available now. Use at most two tool calls to apply the single most important remaining concrete deliverable you already discovered (do not explore or read new files), then give the final status: current-task changes plus validation evidence, or a single short line stating the next unfinished action. Do not loop.';
}

export function malformedToolCallPrompt(toolName: string, chunkBytes: number) {
  const chunkGuidance = toolName === 'writeFile'
    ? ` Keep content below ${chunkBytes} UTF-8 bytes per call: write the first chunk normally, then continue the same file with append=true.`
    : '';
  return `The ${toolName} call had invalid, malformed, or truncated JSON input and did not execute. Retry it now with valid smaller arguments; do not merely announce that you will retry.${chunkGuidance}`;
}

/**
 * Ephemeral control for a goal-continuation slice or a fresh continuation
 * turn. The model's stop was rejected (or its physical turn hit a budget
 * boundary) while structured evidence — declared task counts, post-edit
 * validation — shows unfinished work; this nudge requires resuming concrete
 * work rather than summarizing again. One-request nudge only.
 */
export function goalContinuationPrompt(reason: string, taskCounts?: {total: number; pending: number; inProgress: number; completed: number}) {
  const taskLine = taskCounts
    ? ` The task list currently shows ${taskCounts.pending + taskCounts.inProgress} open item${taskCounts.pending + taskCounts.inProgress === 1 ? '' : 's'} of ${taskCounts.total}; update writeTasks as you complete them.`
    : '';
  return `Continue the active goal: haze rejected stopping because structured evidence shows this turn is not complete (${reason}). Do not summarize again or restate what remains — resume the next concrete unfinished task now.${taskLine} If you declared a task list with writeTasks, its pending and in-progress items are commitments: complete them and update writeTasks at each meaningful phase change and at completion. After any further edits, run the smallest relevant validation and report its real outcome. Report a blocker only when it is a concrete external tool, permission, dependency, or environment failure; unfinished work is not a blocker.`;
}
