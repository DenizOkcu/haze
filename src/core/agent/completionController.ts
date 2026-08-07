import type {ValidationKind} from '../../llm/toolResultTypes.js';
import {MAIN_TOOL_ONLY_STEP_LIMIT} from './budgets.js';
import type {TurnBudget} from './turnBudget.js';
import type {ValidationOutcome} from './workState.js';

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
  finishCause: FinishCause | undefined;
  recoveryUsed: {length: boolean; rescue: boolean};
  budgetBoundary: boolean;
}

/** Project the turn-wide state into the safe evidence shape. */
export function toCompletionEvidence(state: TurnExecutionState): TurnCompletionEvidence {
  return {
    validationOutcome: state.validationOutcome,
    ...(state.validationKind ? {validationKind: state.validationKind} : {}),
    validationAfterMutation: state.validationAfterMutation,
    mutationCount: state.mutationCount,
    finishCause: state.finishCause,
    recoveryUsed: {length: state.lengthCreditUsed, rescue: state.rescueUsed},
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
  if (evidence.lastToolOk === false || evidence.unresolvedToolInputError) return 'failed';
  if (budgetExhausted || state.finishCause === 'length' || state.finishCause === 'error') return 'failed';
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

/**
 * Does the turn have a satisfactory terminal outcome that should stop recovery?
 * A substantive assistant answer (with no known failed tool/validation) is
 * satisfactory. Used by recovery guards so a normal successful turn makes no
 * extra model call.
 */
export function hasSatisfactoryTerminalOutcome(state: TurnExecutionState, evidence: CompletionEvidence): boolean {
  if (state.aborted) return true;
  if (evidence.assistantText.trim().length > 0 && evidence.lastToolOk !== false && !evidence.unresolvedToolInputError) return true;
  return false;
}
