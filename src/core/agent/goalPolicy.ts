/**
 * Goal policy: request-intent classification, session-goal state, and the
 * model-facing completion/continuation control prompts (CR-006 home for the
 * former `core/goal/` directory).
 *
 * Classifiers are hints, not hard authorization. Avoid preventing legitimate
 * work solely because of a heuristic. Plan-only requests should not lead to
 * source mutations unless the user asks for implementation.
 */
import {ASK_TEXT_CHARS, createWorkState, observeWorkToolEvent, openAsksOf, type WorkAsk, type WorkState} from './workState.js';

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

// ── Ask extraction and goal shapes (P2/P5) ──────────────────────────────────

/** Proportional goal shape: selects verification intensity; escalation up only. */
export type GoalShape = 'trivial' | 'bounded' | 'multi-lane' | 'debug';

const GOAL_SHAPE_RANK: Record<GoalShape, number> = {trivial: 0, bounded: 1, 'multi-lane': 2, debug: 3};

/** 1–7 concrete asks per goal (autoprompt's mission re-derivation, haze-native). */
export const MAX_ASKS = 7;

const IMPERATIVE_LEADS = new Set(['add', 'create', 'write', 'implement', 'update', 'change', 'support', 'wire', 'document', 'fix', 'repair', 'resolve', 'remove', 'delete', 'rename', 'refactor', 'extract', 'move', 'migrate', 'ensure', 'include', 'use', 'make', 'build', 'run', 'handle', 'cover', 'configure', 'extend', 'split', 'introduce', 'adopt', 'port', 'clean', 'improve', 'optimize', 'guard', 'prevent', 'teach']);

/** Fragments that imply an ask even without a leading imperative verb ("and a test for it"). */
const IMPLIED_ASK_LEADS = /^(?:an?\s+|the\s+)?(?:unit\s+tests?|tests?|integration\s+tests?|e2e\s+tests?|docs?|documentation|comments?|changelog|readme|examples?|types?|validation|coverage)\b/i;

const LEAD_NOISE = /^(?:please|also|then|additionally|finally|next|first(?:ly)?|secondly|can\s+you|could\s+you|you\s+(?:should|must|also)\b|and\b|but\b)\s+/gi;

function clauseFragments(request: string): string[] {
  const sentences = request.split(/[.!?(\n;]+/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fragments: string[] = [];
  for (const sentence of sentences) {
    // Split coordinating boundaries only when the right side can stand as its
    // own ask (starts with an imperative verb or an implied-ask noun); plain
    // "add X and Y" stays one ask.
    const parts = sentence.split(/\s+(?:and|then|plus|also|as\s+well\s+as)\s+/i);
    let carried = '';
    for (const part of parts) {
      const fragment = part.replace(/^[,\s]+/, '').replace(/[,\s]+$/, '');
      if (!fragment) continue;
      if (carried && startsLikeAsk(fragment)) {
        fragments.push(carried);
        carried = fragment;
      } else {
        carried = carried ? `${carried} and ${fragment}` : fragment;
      }
    }
    if (carried) fragments.push(carried);
  }
  return fragments;
}

function startsLikeAsk(fragment: string): boolean {
  const cleaned = fragment.replace(LEAD_NOISE, '').trim();
  if (!cleaned) return false;
  const firstWord = cleaned.split(/\s+/)[0]!.toLowerCase().replace(/[^a-z]/g, '');
  return IMPERATIVE_LEADS.has(firstWord) || IMPLIED_ASK_LEADS.test(cleaned);
}

function normalizeAskText(fragment: string): string {
  const cleaned = fragment.replace(LEAD_NOISE, '').replace(/^[,\s]+/, '');
  const text = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return text.length > ASK_TEXT_CHARS ? `${text.slice(0, ASK_TEXT_CHARS - 1)}…` : text;
}

/**
 * Deterministically derive 1–7 concrete, checkable asks from the exact user
 * request (P2a: seeded from the request text itself — imperative clauses and
 * coordinating boundaries; no extra model call). Hints, not hard authorization:
 * an ask that is genuinely N/A must be waivable with a reason, and extraction
 * failure degrades to an empty list (no ask gate) rather than a deadlock.
 */
export function deriveRequestAsks(request: string): string[] {
  const asks: string[] = [];
  const seen = new Set<string>();
  for (const fragment of clauseFragments(request)) {
    if (!startsLikeAsk(fragment)) continue;
    const ask = normalizeAskText(fragment);
    const key = ask.toLowerCase();
    if (!ask || seen.has(key)) continue;
    seen.add(key);
    asks.push(ask);
    if (asks.length >= MAX_ASKS) break;
  }
  return asks;
}

/**
 * Proportional shape classification (P5), deterministic at goal start:
 * `debug` for fix intents (red→green required), `multi-lane` for 3+ asks,
 * `trivial` for single-ask short requests (lightweight loop, floor intact),
 * `bounded` otherwise. Heuristics are hints; escalation up only, never down.
 */
export function classifyGoalShape(request: string, intent: RequestIntent, askCount: number): GoalShape {
  if (intent === 'fix') return 'debug';
  if (askCount >= 3) return 'multi-lane';
  const compactLength = request.replace(/\s+/g, ' ').trim().length;
  if (askCount <= 1 && compactLength <= 80 && intent !== 'unknown') return 'trivial';
  return 'bounded';
}

/** Escalate a goal shape upward only (recorded); never downward (P5). */
export function escalateGoalShape(current: GoalShape, proposed: GoalShape): {shape: GoalShape; escalated: boolean} {
  return GOAL_SHAPE_RANK[proposed] > GOAL_SHAPE_RANK[current]
    ? {shape: proposed, escalated: true}
    : {shape: current, escalated: false};
}

export const GOAL_SHAPES: readonly GoalShape[] = ['trivial', 'bounded', 'multi-lane', 'debug'];

export function isGoalShape(value: unknown): value is GoalShape {
  return value === 'trivial' || value === 'bounded' || value === 'multi-lane' || value === 'debug';
}

// ── Session goal state ──────────────────────────────────────────────────────

export type SessionGoal = WorkState;
export type GoalToolEvent = Parameters<typeof observeWorkToolEvent>[1];

function shortRequest(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160) || 'current request';
}

export function createSessionGoal(request: string, now = Date.now()): SessionGoal {
  const intent = classifyRequestIntent(request);
  // Ask-shaped completion (P2): request-derived asks replace the canned
  // per-intent criteria for mutating intents; plan/review/answer keep the
  // display-only canned criteria (asks are optional there).
  const askTexts = intentExpectsValidationForAsks(intent) ? deriveRequestAsks(request) : [];
  const asks: WorkAsk[] = askTexts.map((text, index) => ({id: `ask-${index + 1}`, text, status: 'open' as const}));
  const shape = classifyGoalShape(request, intent, asks.length);
  const successCriteria = asks.length > 0
    ? asks.map(ask => ask.text)
    : intent === 'plan'
      ? ['Create or update the requested plan artifact/answer', 'Do not implement source changes unless asked']
      : intent === 'test'
        ? ['Run the requested validation or closest relevant check', 'Report pass/fail accurately']
        : intent === 'review'
          ? ['Inspect the relevant current project state', 'Return evidence-based findings with file paths']
          : intent === 'answer'
            ? ['Answer the user using current project context when needed']
            : ['Inspect the relevant files', 'Make the requested change when needed', 'Validate the change when practical', 'Summarize only current-task changes and validation'];
  return createWorkState(request, intent, successCriteria, now, {asks, shape});
}

/** Asks gate completion only for intents with a mutating deliverable (P2). */
function intentExpectsValidationForAsks(intent: RequestIntent): boolean {
  return intent === 'implement' || intent === 'fix' || intent === 'test';
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
  // The proportional shape rides the status line (P5) so users can see why a
  // small fix ran light and a big feature ran heavy.
  const shapeLine = goal.shape ? ` · ${goal.shape}` : '';
  const openAskCount = openAsksOf(goal).length;
  const askLine = openAskCount > 0 ? ` · ${openAskCount} open ask${openAskCount === 1 ? '' : 's'}` : '';
  return `Goal: ${shortRequest(goal.originalUserRequest)} · ${action}${shapeLine}${askLine}`;
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
 * validation, open asks, red→green pairs, verifier gaps — shows unfinished
 * work; this nudge requires resuming concrete work rather than summarizing
 * again. One-request nudge only.
 */
export function goalContinuationPrompt(reason: string, taskCounts?: {total: number; pending: number; inProgress: number; completed: number}, openAsks?: string[], detail?: string) {
  const taskLine = taskCounts
    ? ` The task list currently shows ${taskCounts.pending + taskCounts.inProgress} open item${taskCounts.pending + taskCounts.inProgress === 1 ? '' : 's'} of ${taskCounts.total}; update writeTasks as you complete them.`
    : '';
  const validationLine = reason.includes('validation')
    ? ' No recognized post-edit validation was recorded. Run one standard test/build command, directly execute the changed artifact as one unchained command, or call shell with purpose=validation for a custom assertion check.'
    : '';
  const askLine = openAsks && openAsks.length > 0
    ? ` Unmet asks from the original request: ${openAsks.slice(0, 3).join('; ')}. Close each one with structured evidence — mark it met via writeTasks askUpdates citing a passing validation command or a changed file — or waive it with a waiverReason if it is genuinely out of scope.`
    : '';
  const redLine = reason.includes('red')
    ? ' No failing repro was captured before the fix landed. Reproduce the reported failure from the report on the unpatched state (or the closest observable equivalent), record it, then make the same check pass — or declare redWaiver via writeTasks with a reason if the failure is genuinely unobservable in this environment.'
    : '';
  const detailLine = detail ? ` ${detail}` : '';
  return `Continue the active goal: haze rejected stopping because structured evidence shows this turn is not complete (${reason}).${validationLine}${askLine}${redLine}${detailLine} Do not summarize again or restate what remains — resume the next concrete unfinished task now.${taskLine} If you declared a task list with writeTasks, its pending and in-progress items are commitments: complete them and update writeTasks at each meaningful phase change and at completion. After any further edits, run the smallest relevant validation and report its real outcome. Report a blocker only when it is a concrete external tool, permission, dependency, or environment failure; unfinished work is not a blocker.`;
}

/** Fix-intent depth discipline (P4, prompt-level): state the suspected root cause and one competing hypothesis before editing. */
export function fixDepthPrompt() {
  return 'Before changing code for a fix: name the deepest-cause function or module you suspect, state one competing hypothesis, and prove the reported failure RED (a failing repro derived from the report) before patching. The completing validation must be the same check turning green. Judge the fix against the cause, not the symptom.';
}
