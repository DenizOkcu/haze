import {inferValidationKind} from '../validation/outputParser.js';

function stableToolKey(toolCall: {toolName: string; input: unknown}) {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.input)}`;
}

/**
 * Identical validation reruns are evidence, not loops: re-running the same
 * recognized check after a fix is the desired red→green flow (observed
 * 2026-10-30 session 30fd6f: a legitimate re-typecheck after an edit was
 * flagged as a repeat, the next request dropped `shell`, and the model's
 * retry of the removed tool failed the whole step). Only shell calls whose
 * unquoted command shape infers a real validation kind are exempt.
 */
export function isValidationRerunToolCall(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as {toolName?: unknown; input?: unknown};
  if (call.toolName !== 'shell') return false;
  if (typeof call.input !== 'object' || call.input === null) return false;
  const command = (call.input as {command?: unknown}).command;
  return typeof command === 'string' && inferValidationKind(command) !== 'generic';
}

export function uniqueRepeatedToolNames(toolCalls: Array<{toolName: string; input: unknown}>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const toolCall of toolCalls) {
    if (isValidationRerunToolCall(toolCall)) continue;
    const key = stableToolKey(toolCall);
    if (seen.has(key)) repeated.add(toolCall.toolName);
    seen.add(key);
  }
  return [...repeated];
}

/**
 * Return tool names whose latest-step calls repeat an earlier identical call.
 * The next request redirects them with a one-step instruction — tools are
 * never removed from the request (removal once let a model retry a dropped
 * tool and fail the step). Validation reruns are never flagged.
 */
export function latestRepeatedToolNames(steps: Array<{toolCalls: Array<{toolName: string; input: unknown}>}>) {
  const latest = steps.at(-1);
  if (!latest) return [];
  const seen = new Set(steps.slice(0, -1).flatMap(step => step.toolCalls).map(stableToolKey));
  const repeated = new Set<string>();
  for (const toolCall of latest.toolCalls) {
    if (isValidationRerunToolCall(toolCall)) continue;
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
