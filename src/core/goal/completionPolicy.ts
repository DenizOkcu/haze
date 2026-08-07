export function toolLoopBudgetPrompt() {
  return 'Tool slice reached for this model step — tools are no longer callable in this turn. Stop attempting to describe or announce tool calls (e.g. "Let me install", "Now I\'ll run", "Let me X"); those phrases imply tool use you cannot perform. Answer once: either the final status template (current-turn changes + validation evidence) or, if incomplete, a single short line stating the next concrete unfinished action so haze can continue in a fresh tool slice. Do not repeat yourself, do not loop, do not emit XML/JSON tool-call syntax.';
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
