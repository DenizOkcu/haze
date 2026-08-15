import type {ValidationKind} from '../../llm/toolResultTypes.js';
import {MAIN_TOOL_ONLY_STEP_LIMIT} from './budgets.js';
import type {TurnBudget} from './turnBudget.js';
import {intentExpectsValidation, type ValidationOutcome, type WorkTaskProgress} from './workState.js';
import type {RequestIntent} from '../goal/requestClassifier.js';

/**
 * Normalized reason a model stream finished. Derived from the AI SDK
 * `finishReason` string so policy code never branches on raw provider strings.
 */
export type FinishCause =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'error'
  | 'content-filter'
  | 'unknown';

export function normalizeFinishReason(finishReason: string | undefined): FinishCause {
  switch (finishReason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool-calls': return 'tool-calls';
    case 'error': return 'error';
    case 'content-filter': return 'content-filter';
    default: return 'unknown';
  }
}

/**
 * Turn-wide execution state, accumulated across provider retries and recovery
 * slices. It is the single source of truth for "how much of the global budget
 * has this whole turn consumed" and for completion evidence.
 *
 * Counters are turn-wide (never per-slice): a retry or recovery slice observes
 * prior usage so the global budget cannot be reset or exceeded.
 */
export interface TurnExecutionState {
  stepsUsed: number;
  toolCallsUsed: number;
  toolOnlyStepsUsed: number;
  finishCause: FinishCause | undefined;
  /** Length-continuation credit (Increment 2). */
  lengthCreditUsed: boolean;
  lengthRecoveriesAttempted: number;
  /** Completion-rescue credit (Increment 2). */
  rescueUsed: boolean;
  /** Observable work evidence (Increment 3). */
  mutationCount: number;
  validationOutcome: ValidationOutcome;
  validationKind: ValidationKind | undefined;
  validationAfterMutation: boolean;
  /** Request intent driving the validation policy (implement/fix/test expect validation). */
  intent: RequestIntent;
  /** Latest current-turn task-list evidence from a successful writeTasks call. */
  taskProgress: WorkTaskProgress | undefined;
  /** Goal-continuation cycles issued this turn (bounded by the global budget + progress guard). */
  goalContinuationsUsed: number;
  /** Work/task evidence signature recorded when the latest goal continuation was issued. */
  goalContinuationProgress: string | undefined;
  /** Whether the single allowed no-progress corrective nudge has been consumed. */
  goalContinuationCorrectiveUsed: boolean;
  budgetBoundary: boolean;
  aborted: boolean;
}

export function createTurnExecutionState(): TurnExecutionState {
  return {
    stepsUsed: 0,
    toolCallsUsed: 0,
    toolOnlyStepsUsed: 0,
    finishCause: undefined,
    lengthCreditUsed: false,
    lengthRecoveriesAttempted: 0,
    rescueUsed: false,
    mutationCount: 0,
    validationOutcome: 'absent',
    validationKind: undefined,
    validationAfterMutation: false,
    intent: 'unknown',
    taskProgress: undefined,
    goalContinuationsUsed: 0,
    goalContinuationProgress: undefined,
    goalContinuationCorrectiveUsed: false,
    budgetBoundary: false,
    aborted: false,
  };
}

/**
 * Bounded, safe completion evidence for headless/CI consumers. Contains only
 * enums, booleans, and counts — never raw commands, tool inputs/outputs, or
 * credentials. Additive on top of existing JSON/stream-JSON results.
 */
export interface TurnCompletionEvidence {
  validationOutcome: ValidationOutcome;
  validationKind?: ValidationKind;
  validationAfterMutation: boolean;
  mutationCount: number;
  /** Current-turn task counts from writeTasks, when a task list was declared. */
  taskProgress?: {total: number; pending: number; inProgress: number; completed: number};
  finishCause: FinishCause | undefined;
  recoveryUsed: {length: boolean; rescue: boolean; goal: number};
  budgetBoundary: boolean;
}

/** Project the turn-wide state into the safe evidence shape. */
export function toCompletionEvidence(state: TurnExecutionState): TurnCompletionEvidence {
  return {
    validationOutcome: state.validationOutcome,
    ...(state.validationKind ? {validationKind: state.validationKind} : {}),
    validationAfterMutation: state.validationAfterMutation,
    mutationCount: state.mutationCount,
    ...(state.taskProgress ? {taskProgress: {total: state.taskProgress.total, pending: state.taskProgress.pending, inProgress: state.taskProgress.inProgress, completed: state.taskProgress.completed}} : {}),
    finishCause: state.finishCause,
    recoveryUsed: {length: state.lengthCreditUsed, rescue: state.rescueUsed, goal: state.goalContinuationsUsed},
    budgetBoundary: state.budgetBoundary,
  };
}

/** Evidence snapshot the terminal-status decision consumes (decoupled from WorkState). */
export interface CompletionEvidence {
  sawToolCall: boolean;
  assistantText: string;
  lastToolOk: boolean | undefined;
  unresolvedToolInputError: boolean;
}

export type TurnStatus = 'complete' | 'aborted' | 'failed';

/**
 * Reasoned completion readiness from structured current-turn evidence. A
 * voluntary final is acceptable only when the declared work is actually done;
 * prose alone is never evidence of completion (no semantic judge — task,
 * mutation, validation, tool, and budget evidence is authoritative).
 */
export type CompletionReadiness =
  | 'ready'
  | 'pending_tasks'
  | 'validation_failed'
  | 'validation_stale'
  | 'validation_absent_after_mutation'
  | 'tool_failure'
  | 'unresolved_tool_input'
  | 'aborted';

/** Inputs `assessCompletionReadiness` needs; matches the TurnExecutionState projection. */
export interface CompletionReadinessInput {
  aborted: boolean;
  intent: RequestIntent;
  mutationCount: number;
  validationOutcome: ValidationOutcome;
  taskProgress: WorkTaskProgress | undefined;
}

/**
 * Pure completion-readiness assessment. Priority: abort, unresolved tool
 * input, failed tool, declared task progress, then intent-sensitive validation
 * policy (implement/fix/test turns with successful mutations require fresh
 * passing validation; plan/review/answer turns never do). A task list is
 * enforced only when this turn declared one via a successful writeTasks call.
 */
export function assessCompletionReadiness(state: CompletionReadinessInput, evidence: Pick<CompletionEvidence, 'lastToolOk' | 'unresolvedToolInputError'>): CompletionReadiness {
  if (state.aborted) return 'aborted';
  if (evidence.unresolvedToolInputError) return 'unresolved_tool_input';
  if (evidence.lastToolOk === false) return 'tool_failure';
  if (state.taskProgress && (state.taskProgress.pending > 0 || state.taskProgress.inProgress > 0)) return 'pending_tasks';
  if (intentExpectsValidation(state.intent)) {
    if (state.validationOutcome === 'failed') return 'validation_failed';
    if (state.validationOutcome === 'stale') return 'validation_stale';
    if (state.validationOutcome === 'absent' && state.mutationCount > 0) return 'validation_absent_after_mutation';
  }
  return 'ready';
}

/** Human-readable, safe (no commands/content) description of a readiness result. */
export function describeCompletionReadiness(readiness: CompletionReadiness, taskProgress?: WorkTaskProgress): string {
  switch (readiness) {
    case 'pending_tasks': {
      const open = taskProgress ? taskProgress.pending + taskProgress.inProgress : 0;
      return `${open} declared task${open === 1 ? '' : 's'} still pending or in progress`;
    }
    case 'validation_failed': return 'the latest validation failed and remains unresolved';
    case 'validation_stale': return 'edits landed after the latest validation';
    case 'validation_absent_after_mutation': return 'edits landed without any relevant validation';
    case 'tool_failure': return 'the last tool call failed';
    case 'unresolved_tool_input': return 'a tool call never executed because its input was invalid';
    case 'aborted': return 'the turn was aborted';
    case 'ready': return 'declared work is complete';
  }
}

/**
 * True when the turn-wide budget is exhausted. Expressed against turn-wide
 * counters so a retry or recovery slice observes prior usage and the global
 * budget cannot be reset or exceeded. A `length` finish counts as exhausted
 * for the *terminal* status (the output was truncated); recovery uses
 * `hasRemainingRecoveryBudget` instead, because a length finish often leaves
 * plenty of step/tool budget.
 */
export function isBudgetExhausted(state: Pick<TurnExecutionState, 'stepsUsed' | 'toolCallsUsed' | 'toolOnlyStepsUsed' | 'finishCause'>, budget: TurnBudget): boolean {
  return state.finishCause === 'length'
    || state.stepsUsed >= budget.stepLimit
    || state.toolCallsUsed >= budget.toolCallLimit
    || state.toolOnlyStepsUsed >= budget.toolOnlyStepLimit;
}

/** Whether step/tool-call resources remain for a recovery slice (length finish excluded). */
export function hasRemainingRecoveryBudget(state: Pick<TurnExecutionState, 'stepsUsed' | 'toolCallsUsed'>, budget: TurnBudget): boolean {
  return state.stepsUsed < budget.stepLimit && state.toolCallsUsed < budget.toolCallLimit;
}

/**
 * Authoritative terminal turn status. This is the pure, unit-testable core of
 * the old inline `terminalTurnStatus` in the CLI layer; the CLI wrapper still
 * owns the single call site.
 *
 * `budgetExhausted` is supplied by the caller (typically via `isBudgetExhausted`)
 * so this function stays free of budget-wiring details and a turn-wide caller
 * and a per-slice caller can share one decision.
 *
 * Increment 1 reproduces historical behavior exactly: a `length` finish is a
 * failure (length-continuation lands in Increment 2 and only flips on when a
 * recovery credit is both available and warranted).
 */
export function decideTerminalStatus(state: TurnExecutionState, evidence: CompletionEvidence, budgetExhausted: boolean): TurnStatus {
  if (state.aborted) return 'aborted';
  if (budgetExhausted || state.finishCause === 'length' || state.finishCause === 'error') return 'failed';
  if (assessCompletionReadiness(state, evidence) !== 'ready') return 'failed';
  if (evidence.sawToolCall && evidence.assistantText.trim().length === 0) return 'failed';
  return evidence.assistantText.trim().length > 0 ? 'complete' : 'failed';
}

export type RecoveryAction = 'continue' | 'stop';

export interface RecoverySlice {
  steps: number;
  toolCalls: number;
}

export interface LengthRecoveryDecision {
  action: RecoveryAction;
  reason: string;
  /** Slice size to request when action is 'continue'. */
  slice: RecoverySlice;
}

export interface RescueRecoveryDecision {
  action: RecoveryAction;
  reason: string;
  slice: RecoverySlice;
}

/** Length-continuation slice cap: four model steps / four tool calls (global). */
export const LENGTH_RECOVERY_SLICE: RecoverySlice = {steps: 4, toolCalls: 4};
/** Completion-rescue slice: one tool-bearing step (≤2 calls) + one synthesis step. */
export const RESCUE_SLICE: RecoverySlice = {steps: 2, toolCalls: 2};
/** Number of trailing tool-only slots reserved for the rescue slice. */
export const RESCUE_RESERVE = 1;
/** Tool-only boundary at which rescue becomes eligible (normal exploration stops here). */
export const RESCUE_BOUNDARY = MAIN_TOOL_ONLY_STEP_LIMIT - RESCUE_RESERVE;

/**
 * Length-continuation decision. Fires once per turn when an output-length finish
 * truncates the response, the turn is not aborted, the credit is unused, the
 * global budget still has room, and the work is not already satisfactorily
 * validated (a fresh passing validation means the artifact landed). A repeated
 * length finish terminates cleanly because the credit is single-use.
 */
export function decideLengthRecovery(state: TurnExecutionState, budget: TurnBudget): LengthRecoveryDecision {
  const stop = (reason: string): LengthRecoveryDecision => ({action: 'stop', reason, slice: LENGTH_RECOVERY_SLICE});
  if (state.aborted) return stop('turn aborted');
  if (state.finishCause !== 'length') return stop('finish is not a length truncation');
  if (state.lengthCreditUsed) return stop('length-continuation credit already used');
  if (!hasRemainingRecoveryBudget(state, budget)) return stop('global budget exhausted');
  if (state.validationOutcome === 'passed') return stop('fresh passing validation already observed');
  return {action: 'continue', reason: 'output-length finish with budget remaining', slice: LENGTH_RECOVERY_SLICE};
}

/**
 * Whether a request intent has a deliverable the rescue slice could apply or
 * validate. Deliberately matches `intentExpectsValidation` so a test-orchestration
 * turn (F-04) gets the same bounded rescue as implement/fix: a `test` finish is
 * driven by tool runs exactly like the intents `decideRescue` already serves.
 */
export function rescueEligibleRequest(intent: RequestIntent): boolean {
  return intentExpectsValidation(intent);
}

/**
 * Completion-rescue decision near the tool-only boundary. Fires once when normal
 * exploration exhausted the (reserved) tool-only slots without producing a
 * substantive answer, the turn is not aborted, the rescue credit is unused, and
 * the global budget still has room. Rescue never reopens discovery and never
 * extends the global budget.
 */
export function decideRescue(state: TurnExecutionState, evidence: CompletionEvidence, budget: TurnBudget, isMutatingRequest: boolean): RescueRecoveryDecision {
  const stop = (reason: string): RescueRecoveryDecision => ({action: 'stop', reason, slice: RESCUE_SLICE});
  if (state.aborted) return stop('turn aborted');
  if (state.rescueUsed) return stop('rescue credit already used');
  if (state.finishCause !== 'stop' && state.finishCause !== 'tool-calls' && state.finishCause !== 'length') return stop('finish is not a normal/tool boundary stop');
  if (!isMutatingRequest) return stop('request has no deliverable to apply');
  if (state.toolOnlyStepsUsed < RESCUE_BOUNDARY) return stop('not near the tool-only boundary');
  if (hasSatisfactoryTerminalOutcome(state, evidence)) return stop('substantive terminal outcome already present');
  if (!hasRemainingRecoveryBudget(state, budget)) return stop('global budget exhausted');
  return {action: 'continue', reason: 'near tool-only boundary with no substantive answer', slice: RESCUE_SLICE};
}

/** Goal-continuation slice: real per-cycle work headroom, clamped to remaining global budget. */
export const GOAL_CONTINUATION_SLICE: RecoverySlice = {steps: 6, toolCalls: 12};

export interface GoalContinuationDecision {
  action: RecoveryAction;
  reason: string;
  /** Slice size to request when action is 'continue'. */
  slice: RecoverySlice;
}

/** Readiness reasons a bounded continuation can plausibly resolve with more work. */

/** Readiness reasons a bounded continuation can plausibly resolve with more work. */
export function goalContinuationRecoverable(readiness: CompletionReadiness): boolean {
  return readiness === 'pending_tasks'
    || readiness === 'validation_failed'
    || readiness === 'validation_stale'
    || readiness === 'validation_absent_after_mutation';
}

/**
 * Normal provider finishes that can still represent recoverable unfinished
 * work. `stop` is a voluntary final; `tool-calls` is a step/slice budget
 * boundary (often with a runtime-forced progress line); `length` is output
 * truncation; `unknown` is an unmapped but non-erroneous finish. `error` and
 * `content-filter` stay hard: they are provider failures, not work states.
 */
const RECOVERABLE_FINISH_CAUSES: ReadonlySet<FinishCause> = new Set(['stop', 'tool-calls', 'length', 'unknown'] as const);

export function isRecoverableFinishCause(finishCause: FinishCause | undefined): boolean {
  return finishCause != null && RECOVERABLE_FINISH_CAUSES.has(finishCause);
}

/**
 * Terminal classification of a finished attempt against the logical goal.
 *  - `goal-complete`: readiness satisfied, substantive answer, clean stop.
 *  - `recoverable-incomplete`: structured readiness shows declared work
 *    remaining (pending tasks, missing/stale/failed validation after edits)
    *    and the finish shape can still be continued — regardless of turn
 *    budget. A budget boundary ends a physical turn, not the goal.
 *  - `hard-blocked`: concrete tool/input failure, provider error, or a
 *    readiness that more work cannot resolve.
 *  - `user-aborted`.
 */
export type TerminalClassification = 'goal-complete' | 'recoverable-incomplete' | 'hard-blocked' | 'user-aborted';

export function classifyTerminalOutcome(state: TurnExecutionState, evidence: CompletionEvidence): TerminalClassification {
  if (state.aborted) return 'user-aborted';
  const readiness = assessCompletionReadiness(state, evidence);
  if (readiness === 'ready') {
    return evidence.assistantText.trim().length > 0 && state.finishCause === 'stop' ? 'goal-complete' : 'hard-blocked';
  }
  if (!goalContinuationRecoverable(readiness)) return 'hard-blocked';
  return isRecoverableFinishCause(state.finishCause) ? 'recoverable-incomplete' : 'hard-blocked';
}

/** Compact signature of measurable work: mutations, validation outcome/kind, task counts. */
export function goalProgressSignature(state: Pick<TurnExecutionState, 'mutationCount' | 'validationOutcome' | 'validationKind' | 'taskProgress'>): string {
  const tasks = state.taskProgress;
  return JSON.stringify([state.mutationCount, state.validationOutcome, state.validationKind ?? '', tasks ? [tasks.revision, tasks.pending, tasks.inProgress, tasks.completed] : null]);
}

/**
 * Record that a goal-continuation slice was issued. Progress since the previous
 * continuation (work/task signature comparison) decides whether this issuance
 * is the single allowed corrective nudge; a second no-progress stop then
 * terminates as failed (see `decideGoalContinuation`). Never resets counters.
 */
export function recordGoalContinuation(state: TurnExecutionState) {
  const signature = goalProgressSignature(state);
  state.goalContinuationCorrectiveUsed = state.goalContinuationProgress != null && signature === state.goalContinuationProgress;
  state.goalContinuationProgress = signature;
  state.goalContinuationsUsed += 1;
}

/**
 * Goal-continuation decision for a `recoverable-incomplete` attempt with a
 * substantive answer to reject: continue in-turn with a slice when the global
 * budget and progress guard allow it. Any other outcome is the caller's signal
 * to end the physical turn — the goal-level invariant (failed + recoverable +
 * no same-turn recovery → `incomplete-goal` checkpoint) is enforced by the
 * caller via `classifyTerminalOutcome`, not here. Never resets budgets.
 */
export function decideGoalContinuation(state: TurnExecutionState, evidence: CompletionEvidence, budget: TurnBudget): GoalContinuationDecision {
  const stop = (reason: string): GoalContinuationDecision => ({action: 'stop', reason, slice: GOAL_CONTINUATION_SLICE});
  if (state.aborted) return stop('turn aborted');
  if (!isRecoverableFinishCause(state.finishCause)) return stop('finish shape is not recoverable');
  if (evidence.assistantText.trim().length === 0) return stop('no substantive final to reject');
  if (evidence.lastToolOk === false || evidence.unresolvedToolInputError) return stop('unresolved tool failure');
  const readiness = assessCompletionReadiness(state, evidence);
  if (readiness === 'ready') return stop('completion readiness satisfied');
  if (!goalContinuationRecoverable(readiness)) return stop(`readiness '${readiness}' is not autonomously recoverable`);
  if (!hasRemainingRecoveryBudget(state, budget)) return stop('global budget exhausted');
  if (state.goalContinuationProgress != null && goalProgressSignature(state) === state.goalContinuationProgress && state.goalContinuationCorrectiveUsed) {
    return stop('no measurable progress after the corrective nudge');
  }
  return {action: 'continue', reason: `premature final rejected: ${readiness}`, slice: GOAL_CONTINUATION_SLICE};
}

/**
 * Does the turn have a satisfactory terminal outcome that should stop recovery?
 * A substantive assistant answer is satisfactory only when the structured
 * completion evidence agrees: declared tasks finished, no unresolved tool
 * failure, and (for validation-bearing intents) fresh validation after edits.
 * Used by recovery guards so a normal successful turn makes no extra model call.
 */
export function hasSatisfactoryTerminalOutcome(state: TurnExecutionState, evidence: CompletionEvidence): boolean {
  if (state.aborted) return true;
  if (evidence.assistantText.trim().length === 0) return false;
  return assessCompletionReadiness(state, evidence) === 'ready';
}
