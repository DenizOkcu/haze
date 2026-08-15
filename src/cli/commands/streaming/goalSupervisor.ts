import type {ContextFile} from '../../../config/contextFiles.js';
import {agentEvent} from '../../../core/agent/events.js';
import {DEFAULT_TURN_DEADLINE_MS} from '../../../core/agent/budgets.js';
import type {TurnCompletionEvidence} from '../../../core/agent/completionController.js';
import {describeCompletionReadiness} from '../../../core/agent/completionController.js';
import type {ValidationOutcome} from '../../../core/agent/workState.js';
import type {PromptSession} from '../../../llm/systemPrompt.js';
import type {TurnExecutionScope} from '../../../llm/requestContext.js';
import {goalContinuationPrompt} from '../../../core/agent/goalPolicy.js';
import {runAgentTurn, type StreamCallbacks, type TurnExecutionOptions, type TurnResult} from '../streaming.js';
import {goalCheckpointSignature, type GoalCheckpoint, type IncompleteGoalResume} from './goalCheckpoint.js';

/** Why a logical goal stopped. `completed` is the only success. */
export type GoalStopReason = 'completed' | 'no-progress' | 'goal-deadline' | 'blocked' | 'model-error' | 'model-stream-idle' | 'user-aborted';

/** Authoritative outcome of a logical goal (one or more physical turns). */
export interface GoalRunResult {
  status: 'complete' | 'failed' | 'aborted';
  stopReason: GoalStopReason;
  /** Physical turns consumed by the logical goal. */
  cycles: number;
  /** Last physical turn's bounded evidence. */
  evidence?: TurnCompletionEvidence;
  /**
   * Present only for genuinely paused goals (no-progress, deadline, idle
   * stall): what an explicit resume needs. Automatic continuation has already
   * been attempted; this never rides a `completed` result.
   */
  resume?: {kind: 'model-stream-idle'; request: string; retryAttempt: number} | {kind: 'incomplete-goal'; checkpoint: GoalCheckpoint};
}

export interface GoalRunOptions {
  request: string;
  displayValue?: string;
  contextFiles: ContextFile[];
  callbacks: StreamCallbacks;
  session?: PromptSession;
  modelOverride?: string;
  /** Whole-logical-goal wall-clock budget (headless `--timeout`); unset means continue while progress. */
  goalDeadlineMs?: number;
  /** Base per-turn options (attachments, blessed paths); attachments apply to the first physical turn only. */
  turnOptions?: TurnExecutionOptions;
  /** Explicit resume of a paused goal: an idle-stalled turn pool or a stored goal checkpoint. */
  resumeFrom?: {kind: 'model-stream-idle'; retryAttempt: number} | {kind: 'incomplete-goal'; checkpoint: GoalCheckpoint};
}

/** Pause after this many consecutive physical turns without measurable progress (one corrective cycle allowed). */
const GOAL_NO_PROGRESS_LIMIT = 2;

function checkpointFromResume(resume: IncompleteGoalResume, noProgressCount: number): GoalCheckpoint {
  const validationOutcome: ValidationOutcome = resume.validationOutcome ?? 'not_applicable';
  return {
    goalId: resume.goalId,
    request: resume.request,
    cycle: resume.cycle,
    readiness: resume.reason,
    ...(resume.taskCounts ? {taskCounts: resume.taskCounts} : {}),
    mutationCount: resume.mutationCount,
    validationOutcome,
    progressSignature: goalCheckpointSignature({mutationCount: resume.mutationCount, validationOutcome, taskCounts: resume.taskCounts}),
    noProgressCount,
  };
}

function countsToTaskProgress(counts: NonNullable<GoalCheckpoint['taskCounts']>) {
  return {total: counts.total, pending: counts.pending, inProgress: counts.inProgress, completed: counts.completed, revision: 1};
}

/**
 * Logical-goal supervisor. Runs bounded physical turns (`runAgentTurn`) until
 * the user's goal is structurally complete, autonomously starting the next
 * physical turn whenever the previous one ended `recoverable-incomplete` —
 * including at step/tool budget boundaries, which end a physical turn, not the
 * goal. Per-turn limits stay safety boundaries; they no longer imply goal
 * completion.
 *
 * Stops only for: structured completion, a concrete external blocker (hard
 * tool/provider failure), user cancellation, the goal-level deadline, or
 * repeated no-progress cycles. Conversation and completed tool results carry
 * across turns, so mutations are never replayed. Emits exactly one `goal_start`
 * and one terminal `goal_end`, plus `goal_continue` between physical turns.
 */
export async function runAgentGoal(options: GoalRunOptions): Promise<GoalRunResult> {
  const {request, contextFiles, callbacks} = options;
  const startedAt = Date.now();
  const goalId = options.resumeFrom?.kind === 'incomplete-goal' ? options.resumeFrom.checkpoint.goalId : `goal-${startedAt}-${Math.random().toString(36).slice(2)}`;
  const sharedTurnScope: {executionScope?: TurnExecutionScope} = {};
  let checkpoint: GoalCheckpoint | undefined = options.resumeFrom?.kind === 'incomplete-goal' ? options.resumeFrom.checkpoint : undefined;
  let initialRetryAttempt = options.resumeFrom?.kind === 'model-stream-idle' ? options.resumeFrom.retryAttempt : 0;
  let cycle = checkpoint?.cycle ?? 0;
  let noProgressCount = checkpoint?.noProgressCount ?? 0;
  let prevSignature = checkpoint?.progressSignature;
  let lastEvidence: TurnCompletionEvidence | undefined;

  callbacks.onEvent?.(agentEvent({type: 'goal_start', goalId, request}));
  // Observable capability line at every goal start (debug panel, --debug LLM
  // log, headless stderr): failures can be tied to runtime behavior, not
  // guessed from semantic versions.
  callbacks.debugLog('goal supervisor enabled; automatic continuation across physical-turn budgets');

  const finish = (status: GoalRunResult['status'], stopReason: GoalStopReason, resume?: GoalRunResult['resume']): GoalRunResult => {
    callbacks.onEvent?.(agentEvent({type: 'goal_end', goalId, status, cycles: cycle, ...(stopReason !== 'completed' ? {stopReason} : {}), ...(lastEvidence ? {evidence: lastEvidence} : {})}));
    return {status, stopReason, cycles: cycle, ...(lastEvidence ? {evidence: lastEvidence} : {}), ...(resume ? {resume} : {})};
  };

  while (true) {
    const remainingMs = options.goalDeadlineMs != null ? options.goalDeadlineMs - (Date.now() - startedAt) : undefined;
    if (cycle > 0 && remainingMs != null && remainingMs <= 0) {
      return finish('failed', 'goal-deadline', checkpoint ? {kind: 'incomplete-goal', checkpoint} : undefined);
    }
    const continuing = cycle > 0 || checkpoint != null || initialRetryAttempt > 0;
    const turnOptions: TurnExecutionOptions = {
      ...options.turnOptions,
      ...(checkpoint
        ? {
          // The conversation already carries the user message; a continuation
          // turn rides it with a synthetic control. Attachments belong to the
          // first attempt only.
          ephemeralControl: goalContinuationPrompt(describeCompletionReadiness(checkpoint.readiness, checkpoint.taskCounts ? countsToTaskProgress(checkpoint.taskCounts) : undefined), checkpoint.taskCounts),
          attachments: undefined,
        }
        : {}),
      // Always tag the turn with the logical goal id/cycle so cycle-0
      // checkpoints carry the supervisor's goal identity, and hydrate carried
      // evidence on continuation turns (a no-op seed for a fresh goal).
      goalContext: {
        goalId,
        cycle: cycle + 1,
        carried: checkpoint
          ? {mutationCount: checkpoint.mutationCount, validationOutcome: checkpoint.validationOutcome, ...(checkpoint.taskCounts ? {taskProgress: countsToTaskProgress(checkpoint.taskCounts)} : {})}
          : {mutationCount: 0, validationOutcome: 'not_applicable'},
        noProgressCount,
      },
      sharedTurnScope,
      ...(remainingMs != null ? {turnDeadlineMs: Math.min(remainingMs, DEFAULT_TURN_DEADLINE_MS)} : {}),
    };
    const result: TurnResult = await runAgentTurn(request, continuing ? undefined : options.displayValue, contextFiles, callbacks, initialRetryAttempt, continuing, false, options.session, options.modelOverride, turnOptions);
    initialRetryAttempt = 0;
    cycle += 1;
    lastEvidence = result.evidence;

    if (result.status === 'complete') return finish('complete', 'completed');
    if (result.status === 'aborted') return finish('aborted', 'user-aborted');

    if (result.resume?.kind === 'incomplete-goal') {
      const next = checkpointFromResume(result.resume, 0);
      noProgressCount = prevSignature != null && next.progressSignature === prevSignature ? noProgressCount + 1 : 0;
      prevSignature = next.progressSignature;
      checkpoint = {...next, noProgressCount};
      if (noProgressCount >= GOAL_NO_PROGRESS_LIMIT) {
        callbacks.addMessage({role: 'system', text: `Unfinished goal paused after ${noProgressCount} cycles without measurable progress (${describeCompletionReadiness(checkpoint.readiness, checkpoint.taskCounts ? countsToTaskProgress(checkpoint.taskCounts) : undefined)}). Completed work is preserved in the conversation. Press R to resume, or send a follow-up.`});
        return finish('failed', 'no-progress', {kind: 'incomplete-goal', checkpoint});
      }
      const remainingNow = options.goalDeadlineMs != null ? options.goalDeadlineMs - (Date.now() - startedAt) : undefined;
      if (remainingNow != null && remainingNow <= 0) {
        callbacks.addMessage({role: 'system', text: 'Goal deadline reached before the remaining work finished. Completed work is preserved in the conversation; send a follow-up to continue.'});
        return finish('failed', 'goal-deadline', {kind: 'incomplete-goal', checkpoint});
      }
      const openTasks = checkpoint.taskCounts ? checkpoint.taskCounts.pending + checkpoint.taskCounts.inProgress : undefined;
      callbacks.onEvent?.(agentEvent({type: 'goal_continue', goalId, cycle, reason: checkpoint.readiness}));
      callbacks.addMessage({role: 'system', text: `Continuing unfinished goal — cycle ${cycle + 1}${openTasks != null ? ` (${openTasks} task${openTasks === 1 ? '' : 's'} remaining)` : ''}: ${describeCompletionReadiness(checkpoint.readiness, checkpoint.taskCounts ? countsToTaskProgress(checkpoint.taskCounts) : undefined)}.`});
      continue;
    }

    if (result.resume?.kind === 'model-stream-idle') {
      // Bounded in-turn retries are exhausted; a transport stall is a concrete
      // external blocker — pause with the existing one-key resume path.
      return finish('failed', 'model-stream-idle', {kind: 'model-stream-idle', request: result.resume.request, retryAttempt: result.resume.retryAttempt});
    }

    // Failed without a checkpoint: hard blocker (failed tool, invalid input,
    // provider error) or an unresolved synthesis failure.
    return finish('failed', result.evidence?.finishCause === 'error' ? 'model-error' : 'blocked');
  }
}
