function stableToolKey(toolCall: {toolName: string; input: unknown}) {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.input)}`;
}

export function uniqueRepeatedToolNames(toolCalls: Array<{toolName: string; input: unknown}>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const toolCall of toolCalls) {
    const key = stableToolKey(toolCall);
    if (seen.has(key)) repeated.add(toolCall.toolName);
    seen.add(key);
  }
  return [...repeated];
}

/**
 * Return tool names whose latest-step calls repeat an earlier identical call.
 * Restricting only the immediately following step prevents one duplicate from
 * disabling an entire tool category for the rest of the turn.
 */
export function latestRepeatedToolNames(steps: Array<{toolCalls: Array<{toolName: string; input: unknown}>}>) {
  const latest = steps.at(-1);
  if (!latest) return [];
  const seen = new Set(steps.slice(0, -1).flatMap(step => step.toolCalls).map(stableToolKey));
  const repeated = new Set<string>();
  for (const toolCall of latest.toolCalls) {
    const key = stableToolKey(toolCall);
    if (seen.has(key)) repeated.add(toolCall.toolName);
    seen.add(key);
  }
  return [...repeated];
}

export function toolOnlyStepCount(steps: Array<{toolCalls: unknown[]; text: string}>) {
  let count = 0;
  for (const step of [...steps].reverse()) {
    if (step.toolCalls.length === 0 || step.text.trim().length > 0) break;
    count += 1;
  }
  return count;
}
