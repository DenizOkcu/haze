/**
 * Goal policy: request-intent classification, session-goal state, and the
 * model-facing completion/continuation control prompts (CR-006 home for the
 * former `core/goal/` directory).
 *
 * Classifiers are hints, not hard authorization. Avoid preventing legitimate
 * work solely because of a heuristic. Plan-only requests should not lead to
 * source mutations unless the user asks for implementation.
 */
import {createWorkState, observeWorkToolEvent, type WorkState} from './workState.js';

// ── Request intent classification ───────────────────────────────────────────

export type RequestIntent = 'implement' | 'fix' | 'test' | 'review' | 'plan' | 'answer' | 'unknown';

export function isPlanOnlyRequest(value: string) {
  return /\b(create|make|write|draft|outline)\s+(?:a\s+)?plan\b|\bplan\s+(?:for|to)\b/i.test(value) && !/\bimplement|execute|do\b/i.test(value);
}

export function classifyRequestIntent(value: string): RequestIntent {
  if (isPlanOnlyRequest(value)) return 'plan';
  if (/\b(review|audit|inspect|analy[sz]e|compare)\b/i.test(value)) return 'review';
  if (/\b(fix|repair|resolve|debug)\b/i.test(value)) return 'fix';
  if (/\b(run|verify|check|validate)\b/i.test(value) || /\btests?\b/i.test(value) && !/\b(add|create|write)\b/i.test(value)) return 'test';
  if (/\b(add|create|write|implement|update|change|support|wire|document|docs|documentation)\b/i.test(value)) return 'implement';
  if (/\b(what|why|how|explain|tell me)\b/i.test(value)) return 'answer';
  return 'unknown';
}

// ── Session goal state ──────────────────────────────────────────────────────

export type SessionGoal = WorkState;
export type GoalToolEvent = Parameters<typeof observeWorkToolEvent>[1];

function shortRequest(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160) || 'current request';
}

export function createSessionGoal(request: string, now = Date.now()): SessionGoal {
  const intent = classifyRequestIntent(request);
  const successCriteria = intent === 'plan'
    ? ['Create or update the requested plan artifact/answer', 'Do not implement source changes unless asked']
    : intent === 'test'
      ? ['Run the requested validation or closest relevant check', 'Report pass/fail accurately']
      : intent === 'review'
        ? ['Inspect the relevant current project state', 'Return evidence-based findings with file paths']
        : intent === 'answer'
          ? ['Answer the user using current project context when needed']
          : ['Inspect the relevant files', 'Make the requested change when needed', 'Validate the change when practical', 'Summarize only current-task changes and validation'];
  return createWorkState(request, intent, successCriteria, now);
}

export function observeGoalToolEvent(goal: SessionGoal, event: GoalToolEvent, now = Date.now()) {
  return observeWorkToolEvent(goal, event, now);
}

export function formatGoalStatus(goal: SessionGoal) {
  const action = goal.phase === 'starting' ? 'starting'
    : goal.phase === 'inspecting' ? 'inspecting'
      : goal.phase === 'editing' ? `${goal.touchedFiles.length} file${goal.touchedFiles.length === 1 ? '' : 's'} changed`
        : goal.phase === 'validating' ? `validation ${goal.validationCommands.at(-1)?.status ?? 'running'}`
          : goal.phase === 'summarizing' ? 'summarizing'
            : 'done';
  return `Goal: ${shortRequest(goal.originalUserRequest)} · ${action}`;
}

// ── Completion/continuation control prompts ─────────────────────────────────
// Keep these small and reusable; prefer one shared helper over embedding
// near-identical model-facing control text in multiple loops. They are
// one-request nudges, never durable conversation history.

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
