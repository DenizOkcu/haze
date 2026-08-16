import {createTurnExecutionState, decideTerminalStatus, normalizeFinishReason, type TurnExecutionState} from '../../../core/agent/completionController.js';
import {agentEvent} from '../../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../../core/agent/errors.js';
import {completionRescuePrompt, goalContinuationPrompt, lengthContinuationPrompt, type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {assessCompletionReadiness, classifyTerminalOutcome, decideGoalContinuation, decideLengthRecovery, decideRescue, describeCompletionReadiness, goalContinuationRecoverable, isBudgetExhausted, rescueEligibleRequest, type CompletionEvidence, type TerminalClassification} from '../../../core/agent/completionController.js';
import {clampSlice, remainingSteps, remainingToolCalls, DEFAULT_TURN_DEADLINE_MS, IDLE_TIMEOUT_MS, type TurnBudget} from '../../../core/agent/budgets.js';
import {deriveValidationOutcome} from '../../../core/agent/workState.js';
import {withoutRejectedAssistantFinal} from '../../../core/agent/requestAssembly.js';
import {buildIncompleteGoalResume} from './goalCheckpoint.js';
import {formatSeconds} from '../formatters.js';
import {retryDelayMs} from './turnRuntime.js';
import {formatIdleMinutes, MAX_MODEL_RETRIES, salvageConversationToLastStep, type AttemptSalvage, type StreamStallGuard} from './stallRecovery.js';
import type {TurnAbortCause} from './abortCause.js';
import type {AttemptStreamOutcome} from './streamLoop.js';
import type {RequestIntent} from '../../../core/agent/goalPolicy.js';
import type {StreamCallbacks, TurnExecutionOptions, TurnResult, TurnStatus} from '../streaming.js';
import type {ValidationOutcome, WorkTaskProgress} from '../../../core/agent/workState.js';

/**
 * CLI adapter for the authoritative turn-status decision. The pure policy
 * lives in `core/agent/completionController.ts`; this keeps the single call site
 * in the agent turn (see streaming/AGENTS.md) and preserves the documented
 * field-based signature exercised by `tests/cli/commands/streaming/attemptOutcome.test.ts`.
 *
 * The optional work-evidence fields (intent, mutation/validation counts, task
 * progress) project the turn-wide `TurnExecutionState`; when omitted, the
 * defaults cannot reject a turn (unknown intent, no mutations, no task list).
 */
export function terminalTurnStatus(input: {aborted: boolean; error?: unknown; assistantText: string; sawToolCall: boolean; lastToolOk?: boolean; finishReason?: string; budgetReached?: boolean; unresolvedToolInputError?: boolean; intent?: RequestIntent; mutationCount?: number; validationOutcome?: ValidationOutcome; taskProgress?: WorkTaskProgress}): TurnStatus {
  void input.error;
  const state: TurnExecutionState = {
    ...createTurnExecutionState(),
    aborted: input.aborted,
    finishCause: normalizeFinishReason(input.finishReason),
    intent: input.intent ?? 'unknown',
    mutationCount: input.mutationCount ?? 0,
    ...(input.validationOutcome ? {validationOutcome: input.validationOutcome} : {}),
    ...(input.taskProgress ? {taskProgress: input.taskProgress} : {}),
  };
  return decideTerminalStatus(
    state,
    {
      sawToolCall: input.sawToolCall,
      assistantText: input.assistantText,
      lastToolOk: input.lastToolOk,
      unresolvedToolInputError: Boolean(input.unresolvedToolInputError),
    },
    Boolean(input.budgetReached),
  );
}

/** Bounded recovery slice an attempt proposes for the next agent call. */
type AttemptRecovery = {kind: 'length' | 'rescue' | 'goal'; control: string; slice: {maxSteps: number; maxToolCalls: number}};

/** Internal per-attempt result: the turn outcome plus retry/recovery directives for `runAgentTurn`. */
export type AgentAttemptResult = TurnResult & {
  retry?: {attempt: number; contextOverflowRecovered: boolean; delayMs: number; /** The retry aborts the previous controller (idle stall); hand the loop a fresh one. */ freshController?: boolean};
  /** When set, run one bounded recovery slice next (length-continuation, rescue, or goal continuation). */
  recovery?: AttemptRecovery;
};

/** Keep terminal evidence truthful on normal, timeout, and forced-settlement paths. */
export function projectGoalEvidence(turnState: TurnExecutionState, goal: SessionGoal) {
  turnState.intent = goal.intent;
  turnState.validationOutcome = deriveValidationOutcome(goal);
  turnState.mutationCount = goal.mutationCount;
  turnState.validationKind = goal.validations.at(-1)?.kind ?? goal.carriedValidation?.kind;
  turnState.validationAfterMutation = goal.validationSeq > 0 && goal.validationSeq >= goal.mutationSeq;
  turnState.taskProgress = goal.taskProgress;
}

export interface AttemptOutcomeDeps {
  value: string;
  callbacks: StreamCallbacks;
  abortController: AbortController;
  turnOptions: TurnExecutionOptions;
  turnState: TurnExecutionState;
  turnBudget: TurnBudget;
  goal: SessionGoal;
  remainingTurnDeadlineMs: () => number;
  stream: AttemptStreamOutcome;
}

/**
 * Classify the finished attempt: project work evidence onto the turn state,
 * decide the authoritative turn status and goal status, then propose bounded
 * recovery (length-continuation, goal continuation, rescue) or an
 * `incomplete-goal` checkpoint when no same-turn recovery can run. Never
 * reports incomplete work as `complete`.
 */
export function finalizeAttemptOutcome(deps: AttemptOutcomeDeps): AgentAttemptResult {
  const {value, callbacks, abortController, turnOptions, turnState, turnBudget, goal, remainingTurnDeadlineMs, stream} = deps;
  turnState.finishCause = normalizeFinishReason(stream.finishReason);
  // Observable work evidence is projected through one helper so abnormal
  // terminal paths report the same cumulative state.
  projectGoalEvidence(turnState, goal);
  turnState.budgetBoundary = isBudgetExhausted(turnState, turnBudget);
  const completionEvidence: CompletionEvidence = {sawToolCall: stream.sawToolCall, assistantText: stream.assistantText, lastToolOk: stream.lastToolOk, unresolvedToolInputError: stream.unresolvedToolInputError};
  const readiness = assessCompletionReadiness(turnState, completionEvidence);
  const classification: TerminalClassification = classifyTerminalOutcome(turnState, completionEvidence);
  const turnStatus = terminalTurnStatus({aborted: false, assistantText: stream.assistantText, sawToolCall: stream.sawToolCall, lastToolOk: stream.lastToolOk, finishReason: stream.finishReason, budgetReached: turnState.budgetBoundary, unresolvedToolInputError: stream.unresolvedToolInputError, intent: turnState.intent, mutationCount: turnState.mutationCount, validationOutcome: turnState.validationOutcome, taskProgress: turnState.taskProgress});
  if (stream.unresolvedMalformedToolName) callbacks.addMessage({role: 'system', text: `${stream.unresolvedMalformedToolName} did not execute because its generated input remained invalid or truncated. The requested work is incomplete.`});
  goal.phase = 'done';
  // Goal status reflects completion readiness, not the shallow text status:
  // unfinished-but-recoverable work is waiting on continuation (supervisor or
  // the user), while tool/input failures are concrete blockers. Prose alone
  // can never turn pending work into 'complete'.
  goal.status = turnStatus === 'aborted' ? 'aborted'
    : turnStatus === 'complete' ? 'complete'
      : readiness === 'tool_failure' || readiness === 'unresolved_tool_input' ? 'blocked'
        : goalContinuationRecoverable(readiness) ? 'needs-user'
          : 'blocked';
  callbacks.setWorkState?.(goal);
  callbacks.setGoalStatus?.(undefined);

  // Bounded recovery + the goal-level invariant. Length/rescue credits are
  // single-use and only the main flow proposes them; goal continuation is
  // repeatable while measurable progress continues. The invariant: when the
  // attempt classified `recoverable-incomplete` and no same-turn recovery can
  // run (budget/deadline boundary, exhausted slice, no-progress guard), the
  // attempt returns an `incomplete-goal` checkpoint — never a silent failure,
  // and never `complete`. The goal supervisor turns checkpoints into fresh
  // physical turns; a bare runAgentTurn caller surfaces them as resume info.
  const goalId = turnOptions.goalContext?.goalId ?? goal.id;
  const goalCycle = turnOptions.goalContext?.cycle ?? 1;
  const discardRejectedFinal = () => callbacks.setConversation(withoutRejectedAssistantFinal(callbacks.getConversation()));
  const checkpointResult = (): AgentAttemptResult => {
    discardRejectedFinal();
    return {status: 'failed', resume: buildIncompleteGoalResume(value, goalId, goalCycle, turnState, readiness)};
  };
  if (!abortController.signal.aborted) {
    const lengthDecision = decideLengthRecovery(turnState, turnBudget);
    if (lengthDecision.action === 'continue') {
      const clamped = clampSlice(lengthDecision.slice, {steps: remainingSteps(turnState.stepsUsed, turnBudget), toolCalls: remainingToolCalls(turnState.toolCallsUsed, turnBudget)});
      if (clamped.steps > 0) return {status: turnStatus, recovery: {kind: 'length', control: lengthContinuationPrompt(), slice: {maxSteps: clamped.steps, maxToolCalls: clamped.toolCalls}}};
    } else {
      const goalDecision = decideGoalContinuation(turnState, completionEvidence, turnBudget);
      const rescueDecision = turnOptions.recoverySlice == null
        ? decideRescue(turnState, completionEvidence, turnBudget, rescueEligibleRequest(goal.intent))
        : undefined;
      const goalSlice = goalDecision.action === 'continue' && remainingTurnDeadlineMs() > 0
        ? clampSlice(goalDecision.slice, {steps: remainingSteps(turnState.stepsUsed, turnBudget), toolCalls: remainingToolCalls(turnState.toolCallsUsed, turnBudget)})
        : undefined;
      const rescueSlice = goalSlice && goalSlice.steps > 0 ? undefined : rescueDecision?.action === 'continue'
        ? clampSlice(rescueDecision.slice, {steps: remainingSteps(turnState.stepsUsed, turnBudget), toolCalls: remainingToolCalls(turnState.toolCallsUsed, turnBudget)})
        : undefined;
      if (goalSlice && goalSlice.steps > 0) {
        discardRejectedFinal();
        if (readiness === 'validation_failed' || readiness === 'validation_stale' || readiness === 'validation_absent_after_mutation') turnState.validationContinuationUsed = true;
        return {status: turnStatus, recovery: {kind: 'goal', control: goalContinuationPrompt(describeCompletionReadiness(readiness, turnState.taskProgress)), slice: {maxSteps: goalSlice.steps, maxToolCalls: goalSlice.toolCalls}}};
      } else if (rescueSlice && rescueSlice.steps > 0) {
        return {status: turnStatus, recovery: {kind: 'rescue', control: completionRescuePrompt(), slice: {maxSteps: rescueSlice.steps, maxToolCalls: rescueSlice.toolCalls}}};
      } else if (classification === 'recoverable-incomplete') {
        // Budget boundary (`tool-calls`), exhausted slice, deadline, or no-progress
        // guard: end the physical turn with a resumable checkpoint.
        callbacks.debugLog(`goal checkpoint: readiness=${readiness}; goalDecision=${goalDecision.reason}; rescueDecision=${rescueDecision?.reason ?? 'not proposed from a recovery slice'}`);
        return checkpointResult();
      }
    }
  }
  return {status: turnStatus};
}

export interface AttemptFailureDeps {
  value: string;
  callbacks: StreamCallbacks;
  abortController: AbortController;
  turnState: TurnExecutionState;
  retryAttempt: number;
  contextOverflowRecovered: boolean;
  abortCause: TurnAbortCause;
  stallGuard: StreamStallGuard | undefined;
  salvage: AttemptSalvage;
  error: unknown;
}

/**
 * Classify a failed attempt from the recorded abort cause and the error:
 * idle-stall retry/pause (shared bounded retry pool), absolute turn deadline,
 * user abort, context-overflow compaction retry, transient model retry, or a
 * hard model-call failure. Completed-step progress is always preserved.
 */
export function handleAttemptFailure(deps: AttemptFailureDeps): AgentAttemptResult {
  const {value, callbacks, abortController, turnState, retryAttempt, contextOverflowRecovered, abortCause, stallGuard, salvage, error} = deps;
  if (abortController.signal.aborted) {
    if (abortCause.kind === 'model-stream-idle') {
      // Transport stall, not a user cancel. Preserve completed work first: the
      // conversation is salvaged from the last fully completed step so an
      // automatic retry (or a user-triggered resume) continues from there
      // instead of re-running — possibly mutating — tool work.
      salvageConversationToLastStep(callbacks, salvage);
      if (stallGuard?.retryEligible) {
        const delay = retryDelayMs(retryAttempt);
        callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: MAX_MODEL_RETRIES, delayMs: delay, error: `model stream idle for ${formatSeconds(IDLE_TIMEOUT_MS)}`}));
        callbacks.addMessage({role: 'system', text: `Model stream stalled for ${formatIdleMinutes(IDLE_TIMEOUT_MS)}; retrying attempt ${retryAttempt + 1}/${MAX_MODEL_RETRIES} in ${formatSeconds(delay)}. Completed steps are preserved.`});
        // freshController: this stall aborted the controller to kill the hung
        // stream; the retry needs a live signal.
        return {status: 'failed', retry: {attempt: retryAttempt + 1, contextOverflowRecovered, delayMs: delay, freshController: true}};
      }
      // Bounded retries exhausted, or the stalled step emitted partial output.
      // Pause with the active goal preserved (work state is untouched by this
      // path) instead of discarding progress; the interactive UI offers a
      // one-key resume from TurnResult.resume.
      const afterStep = turnState.stepsUsed > 0 ? ` after step ${turnState.stepsUsed}` : '';
      callbacks.addMessage({role: 'system', text: `Model stream stalled for ${formatIdleMinutes(IDLE_TIMEOUT_MS)}; unfinished task paused${afterStep}. Press R to retry, or send a follow-up message to continue.`});
      return {status: 'failed', resume: {kind: 'model-stream-idle', request: value, retryAttempt}};
    }
    if (abortCause.kind === 'turn-deadline') {
      // Absolute turn budget exhausted — distinct from a user cancel: the turn
      // ran out of time, not patience. No retry by definition (the deadline is
      // the bound), but completed-step progress stays in the conversation.
      turnState.aborted = true;
      callbacks.debugLog('turn exceeded the absolute deadline');
      callbacks.addMessage({role: 'system', text: `Turn stopped: the ${formatIdleMinutes(abortCause.timeoutMs ?? DEFAULT_TURN_DEADLINE_MS)} turn budget elapsed before the model finished. Completed steps are preserved in the conversation; send a follow-up to continue.`});
      return {status: 'aborted', abortReason: 'turn-deadline'};
    }
    turnState.aborted = true;
    callbacks.debugLog('request aborted');
    callbacks.addMessage({role: 'system', text: 'Thinking aborted. You can type again.'});
    return {status: 'aborted', abortReason: 'user'};
  }
  const text = error instanceof Error ? error.message : String(error);
  callbacks.debugLog(`error: ${text}`);
  if (!contextOverflowRecovered && isContextOverflowError(error)) {
    const canCompact = typeof callbacks.compactConversation === 'function';
    const compacted = canCompact
      ? callbacks.compactConversation?.('Automatic recovery after provider context overflow. Preserve the active user request and concrete next steps.') ?? false
      : false;
    callbacks.onEvent?.(agentEvent({type: 'context_overflow', recovered: compacted, error: text}));
    if (compacted) {
      callbacks.addMessage({role: 'system', text: 'Context overflow detected; compacted older context and retrying the same request once.'});
      return {status: 'failed', retry: {attempt: retryAttempt, contextOverflowRecovered: true, delayMs: 0}};
    }
    callbacks.addMessage({role: 'system', text: canCompact
      ? 'Context overflow detected, but there was not enough conversation history to compact automatically.'
      : 'Context overflow detected, and this mode does not attempt automatic compaction. Resume the session interactively or retry with a smaller request.'});
  }
  // Transient model errors share the bounded retry pool with idle-stream
  // stalls, so a turn can never retry more than MAX_MODEL_RETRIES times total.
  if (retryAttempt < MAX_MODEL_RETRIES && isRetryableModelError(error)) {
    const delay = retryDelayMs(retryAttempt);
    callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: MAX_MODEL_RETRIES, delayMs: delay, error: text}));
    callbacks.addMessage({role: 'system', text: `Transient model error; retrying attempt ${retryAttempt + 1}/${MAX_MODEL_RETRIES} in ${formatSeconds(delay)}: ${text}`});
    return {status: 'failed', retry: {attempt: retryAttempt + 1, contextOverflowRecovered, delayMs: delay}};
  }
  callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
  return {status: 'failed'};
}
