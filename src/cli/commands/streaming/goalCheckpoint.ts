import crypto from 'node:crypto';
import type {CompletionReadiness, TurnExecutionState} from '../../../core/agent/completionController.js';
import type {RequestIntent} from '../../../core/agent/goalPolicy.js';
import type {RedEvidence, ValidationOutcome, WorkTaskProgress} from '../../../core/agent/workState.js';
import type {GoalLedgerFrontier} from '../../../core/session/sessionStore.js';

/**
 * Bounded continuation checkpoint for a logical goal whose work is recoverably
 * unfinished. Safe metadata only — reasons, counts, enums, and red-evidence
 * command strings without output bodies —
 * never raw content or credentials. Carried on `TurnResult.resume` so a goal
 * supervisor (or the interactive resume affordance) can continue the same
 * logical goal in a fresh physical turn without replaying completed work.
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
  /** sha256 prefix of the exact request bytes; binds downstream evidence to the mission (P1). */
  requestHash?: string;
  /** Captured pre-mutation failing repro for fix goals (P4). */
  redEvidence?: RedEvidence;
  redWaiver?: {reason: string};
  greenSuccessor?: string;
}

/** Supervisor-level checkpoint persisted between physical turns (in memory and, via the goal ledger, in the session JSONL). */
export interface GoalCheckpoint {
  goalId: string;
  request: string;
  cycle: number;
  /**
   * Structured readiness that still blocks completion. Optional for a
   * stored-goal resume whose ledger frontier predates a specific readiness
   * (e.g. a crashed run): the continuation then uses the generic unfinished
   * reason instead of guessing one.
   */
  readiness?: CompletionReadiness;
  taskCounts?: {total: number; pending: number; inProgress: number; completed: number};
  mutationCount: number;
  validationOutcome: ValidationOutcome;
  /** Cumulative progress signature used by the no-progress guard. */
  progressSignature: string;
  /** Consecutive physical turns without measurable progress. */
  noProgressCount: number;
  requestHash?: string;
  intent?: RequestIntent;
  redEvidence?: RedEvidence;
  redWaiver?: {reason: string};
  greenSuccessor?: string;
}

/** Durable goal-ledger append (P1): one entry per supervisor boundary; the writer stamps `type`/`at`. Shared by the supervisor and the session recorder. */
export interface GoalLedgerAppend {
  goalId: string;
  phase: 'goal_start' | 'goal_continue' | 'goal_end';
  request: string;
  requestHash: string;
  intent: RequestIntent;
  cycle: number;
  mutationCount: number;
  validationOutcome: ValidationOutcome;
  progressSignature: string;
  taskCounts?: {total: number; pending: number; inProgress: number; completed: number};
  redEvidence?: RedEvidence;
  redWaiverReason?: string;
  greenSuccessor?: string;
  stopReason?: string;
  status?: 'complete' | 'failed' | 'aborted';
}

/** Hash binding for the exact mission bytes (P1): everything downstream that references "the mission" carries this. */
export function hashRequest(request: string): string {
  return crypto.createHash('sha256').update(request, 'utf8').digest('hex').slice(0, 16);
}

/** Cumulative outcome signature; monotonic mutation activity alone is not net progress. */
export function goalCheckpointSignature(input: {mutationCount: number; validationOutcome: ValidationOutcome; taskCounts?: {pending: number; inProgress: number; completed: number; total: number}}): string {
  return JSON.stringify([input.mutationCount > 0, input.validationOutcome, input.taskCounts ? [input.taskCounts.total, input.taskCounts.pending, input.taskCounts.inProgress, input.taskCounts.completed] : null]);
}

/** Goal-scoped evidence carried across a physical-turn boundary (checkpoint subset). */
export interface CarriedGoalEvidence {
  requestHash?: string;
  intent?: RequestIntent;
  redEvidence?: RedEvidence;
  redWaiver?: {reason: string};
  greenSuccessor?: string;
}

/**
 * Build the checkpoint payload for a `recoverable-incomplete` attempt that no
 * same-turn recovery can continue. Single construction site so every path
 * (voluntary final, budget boundary, tool-calls finish, exhausted recovery
 * slice) yields the same bounded shape.
 */
export function buildIncompleteGoalResume(request: string, goalId: string, cycle: number, state: Pick<TurnExecutionState, 'stepsUsed' | 'mutationCount' | 'validationOutcome' | 'taskProgress'>, reason: CompletionReadiness, carried: CarriedGoalEvidence = {}): IncompleteGoalResume {
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
    ...carried,
  };
}

/** Project task progress into the plain counts shape used by checkpoints and prompts. */
export function taskCountsOf(taskProgress: WorkTaskProgress | undefined): {total: number; pending: number; inProgress: number; completed: number} | undefined {
  return taskProgress ? {total: taskProgress.total, pending: taskProgress.pending, inProgress: taskProgress.inProgress, completed: taskProgress.completed} : undefined;
}

const VALIDATION_OUTCOMES: ReadonlySet<string> = new Set(['passed', 'failed', 'stale', 'absent', 'not_applicable']);

/**
 * Rebuild a supervisor checkpoint from a durable ledger frontier (P1 resume
 * path): safe metadata only, tolerant of ledger fields written by older
 * versions. Carries red→green evidence so a crash resume matches in-process
 * continuation (a captured red repro stays captured).
 * `readiness` stays unset — the frontier predates a specific readiness, so
 * continuation uses the generic unfinished reason.
 */
export function checkpointFromGoalFrontier(frontier: GoalLedgerFrontier): GoalCheckpoint {
  const validationOutcome = (VALIDATION_OUTCOMES.has(frontier.validationOutcome) ? frontier.validationOutcome : 'not_applicable') as ValidationOutcome;
  return {
    goalId: frontier.goalId,
    request: frontier.request,
    cycle: frontier.cycle,
    mutationCount: frontier.mutationCount,
    validationOutcome,
    progressSignature: frontier.progressSignature,
    noProgressCount: 0,
    requestHash: frontier.requestHash,
    ...(frontier.intent ? {intent: frontier.intent as RequestIntent} : {}),
    ...(frontier.taskCounts ? {taskCounts: frontier.taskCounts} : {}),
    ...(frontier.redEvidence ? {redEvidence: {...frontier.redEvidence}} : {}),
    ...(frontier.redWaiverReason ? {redWaiver: {reason: frontier.redWaiverReason}} : {}),
    ...(frontier.greenSuccessor ? {greenSuccessor: frontier.greenSuccessor} : {}),
  };
}
