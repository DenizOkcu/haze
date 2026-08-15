import type {CompletionReadiness, TurnExecutionState} from '../../../core/agent/completionController.js';
import type {ValidationOutcome} from '../../../core/agent/workState.js';

/**
 * Bounded continuation checkpoint for a logical goal whose work is recoverably
 * unfinished. Safe metadata only — reasons, counts, enums — never commands,
 * content, or credentials. Carried on `TurnResult.resume` so a goal supervisor
 * (or the interactive resume affordance) can continue the same logical goal in
 * a fresh physical turn without replaying completed work.
 */
export interface IncompleteGoalResume {
  kind: 'incomplete-goal';
  request: string;
  reason: CompletionReadiness;
  /** Logical-goal id shared across physical turns. */
  goalId: string;
  /** Physical turns consumed so far (including the one producing this). */
  cycle: number;
  stepsUsed: number;
  /** Cumulative successful mutations across the logical goal. */
  mutationCount: number;
  taskCounts?: {total: number; pending: number; inProgress: number; completed: number};
  validationOutcome?: ValidationOutcome;
}

/** Supervisor-level checkpoint persisted between physical turns (in memory). */
export interface GoalCheckpoint {
  goalId: string;
  request: string;
  cycle: number;
  readiness: CompletionReadiness;
  taskCounts?: {total: number; pending: number; inProgress: number; completed: number};
  mutationCount: number;
  validationOutcome: ValidationOutcome;
  /** Cumulative progress signature used by the no-progress guard. */
  progressSignature: string;
  /** Consecutive physical turns without measurable progress. */
  noProgressCount: number;
}

/** Cumulative progress signature: mutations, validation outcome, task counts. */
export function goalCheckpointSignature(input: {mutationCount: number; validationOutcome: ValidationOutcome; taskCounts?: {pending: number; inProgress: number; completed: number; total: number}}): string {
  return JSON.stringify([input.mutationCount, input.validationOutcome, input.taskCounts ? [input.taskCounts.total, input.taskCounts.pending, input.taskCounts.inProgress, input.taskCounts.completed] : null]);
}

/**
 * Build the checkpoint payload for a `recoverable-incomplete` attempt that no
 * same-turn recovery can continue. Single construction site so every path
 * (voluntary final, budget boundary, tool-calls finish, exhausted recovery
 * slice) yields the same bounded shape.
 */
export function buildIncompleteGoalResume(request: string, goalId: string, cycle: number, state: Pick<TurnExecutionState, 'stepsUsed' | 'mutationCount' | 'validationOutcome' | 'taskProgress'>, reason: CompletionReadiness): IncompleteGoalResume {
  return {
    kind: 'incomplete-goal',
    request,
    reason,
    goalId,
    cycle,
    stepsUsed: state.stepsUsed,
    mutationCount: state.mutationCount,
    ...(state.taskProgress ? {taskCounts: {total: state.taskProgress.total, pending: state.taskProgress.pending, inProgress: state.taskProgress.inProgress, completed: state.taskProgress.completed}} : {}),
    ...(state.validationOutcome !== 'not_applicable' ? {validationOutcome: state.validationOutcome} : {}),
  };
}
