import type {LlmLog} from '../../core/log/llmLog.js';
import type {ModelMessage} from 'ai';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import type {ImageAttachment} from '../../core/attachments/imageAttachments.js';
import {type BlessedPath} from '../../core/attachments/readBlessings.js';
import {createTurnExecutionState, describeTurnFailure, toCompletionEvidence} from '../../core/agent/completionController.js';
import type {TurnCompletionEvidence} from '../../core/agent/completionController.js';
import {createSessionGoal} from '../../core/agent/goalPolicy.js';
import {seedCarriedGoalEvidence} from '../../core/agent/workState.js';
import type {RedEvidence, ValidationOutcome, WorkTaskProgress, WorkState} from '../../core/agent/workState.js';
import type {ValidationKind} from '../../llm/toolResultTypes.js';
import {createToolExecutionBudget, mainTurnBudget, DEFAULT_TURN_DEADLINE_MS, OVERFLOW_SHRINK_FACTOR} from '../../core/agent/budgets.js';
import {createAbsoluteDeadline, type AbsoluteDeadline} from '../../core/deadline.js';
import type {ContextUsageAnchor} from '../../core/agent/contextBudget.js';
import type {SubagentOverrides, TurnExecutionScope} from '../../llm/requestContext.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {StoredReasoningSetting} from '../../core/agent/reasoningPolicy.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {goalCheckpointSignature, taskCountsOf, type GoalCheckpoint, type IncompleteGoalResume} from './streaming/goalCheckpoint.js';
import {abortableDelay, type TokenUsage} from './streaming/turnRuntime.js';
import type {ToolDisplayDiff} from './streaming/toolGroupRenderer.js';
import {abortForTurn, createUserAbortCause} from './streaming/abortCause.js';
import {runAgentAttempt} from './streaming/agentAttempt.js';
import {projectGoalEvidence} from './streaming/attemptOutcome.js';
import {awaitAttemptWithForcedSettlement, createAttemptCleanupRegistry, createQuarantinableCallbacks} from './streaming/attemptLifecycle.js';
import {startRecoverySlice} from './streaming/recoverySlices.js';
import {formatIdleMinutes} from '../../utils/format.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number; toolCount?: number; toolDiffs?: ToolDisplayDiff[]};

export type TurnStatus = 'complete' | 'aborted' | 'failed';

/** Authoritative outcome of a turn, so callers (esp. headless/CI) need not sniff message texts. */
export interface TurnResult {
  status: TurnStatus;
  /** Distinguishes a real user cancel from an internal absolute deadline. */
  abortReason?: 'user' | 'turn-deadline';
  /** Bounded, safe completion evidence (no raw commands/output). Additive. */
  evidence?: TurnCompletionEvidence;
  /** Goal-scoped obligations survive every failed exit, including transport failures. */
  checkpoint?: GoalCheckpoint;
  /**
   * The turn paused with recoverable work unfinished; this carries what a
   * one-key/automatic resume needs instead of forcing the user to restate the
   * task. Safe metadata only (reasons, counts, enums) — never commands,
   * content, or credentials.
   *
   * - `model-stream-idle`: the model stream stalled past the idle window and
   *   bounded retries could not continue. The conversation keeps completed
   *   steps; resume continues the same logical turn's retry pool.
   * - `incomplete-goal`: the attempt ended `recoverable-incomplete` (declared
   *   tasks or post-edit validation outstanding) with no same-turn recovery
   *   available — including step/tool budget boundaries that finish as
   *   `tool-calls`. A goal supervisor (or the interactive R key) continues the
   *   logical goal in a fresh physical turn against the preserved
   *   conversation; completed mutations are never replayed.
   */
  resume?: {kind: 'model-stream-idle'; request: string; retryAttempt: number} | IncompleteGoalResume;
}

/** Supervisor-provided logical-goal context: tags checkpoints and seeds cumulative evidence. */
interface TurnGoalContext {
  goalId: string;
  /** 1-based physical-turn counter for the logical goal. */
  cycle: number;
  /** Cumulative evidence carried from earlier physical turns. */
  carried: {mutationCount: number; validationOutcome: ValidationOutcome; taskProgress?: WorkTaskProgress; redEvidence?: RedEvidence; validationKind?: ValidationKind};
  /** Consecutive no-progress physical turns at goal level (diagnostics). */
  noProgressCount: number;
  /** Hash binding of the exact mission bytes (P1); rides every checkpoint downstream. */
  requestHash?: string;
}

export interface TurnExecutionOptions {
  ephemeralControl?: string;
  subagentOverrides?: SubagentOverrides;
  /** User-attached images for this turn (F03); only the first attempt carries them. */
  attachments?: readonly ImageAttachment[];
  /** User-mentioned paths whose reads may escape workspace confinement this turn. */
  blessedPaths?: readonly BlessedPath[];
  /** When set, this attempt is a bounded recovery slice (length-continuation, rescue, or goal continuation). */
  recoverySlice?: {kind: 'length' | 'rescue' | 'goal'; maxSteps: number; maxToolCalls: number};
  /** Absolute turn deadline in milliseconds (headless `--timeout`); defaults to DEFAULT_TURN_DEADLINE_MS. */
  turnDeadlineMs?: number;
  /** Logical-goal context from the goal supervisor; hydrates cumulative evidence so a fresh physical turn cannot complete while carried work remains. */
  goalContext?: TurnGoalContext;
  /** Shared turn scope (coordinator admission + workspace mutation lease) reused across a logical goal's physical turns. */
  sharedTurnScope?: {executionScope?: TurnExecutionScope};
}

export interface StreamCallbacks {
  addMessage: (msg: Message) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  setConversation: (messages: ModelMessage[]) => void;
  setBusy: (busy: boolean) => void;
  setBusyLabel?: (label: string) => void;
  debugLog: (line: string) => void;
  getConversation: () => ModelMessage[];
  getLastAssistantText: () => string;
  setLastAssistantText: (text: string) => void;
  setAbortController?: (controller: AbortController | null) => void;
  setGoalStatus?: (status: string | undefined) => void;
  onEvent?: AgentEventSink;
  compactConversation?: (instructions?: string) => boolean;
  /** Durable compaction audit hook (Pillar 1.7): fired for every automatic compaction that rewrites the conversation, mirroring the session `compact` entry shape. */
  recordCompaction?: (entry: {method: 'heuristic' | 'llm'; olderCount: number; keptCount: number; instructions?: string; summary: string}) => void;
  recordTokenUsage?: (usage: TokenUsage) => void;
  setWorkState?: (state: WorkState) => void;
  onTasksChanged?: () => void;
  log?: LlmLog;
  contextFileSignatures?: Map<string, string>;
}

export async function runAgentTurn(
  value: string,
  displayValue: string | undefined,
  contextFiles: ContextFile[],
  callbacks: StreamCallbacks,
  retryAttempt = 0,
  retryingExistingRequest = false,
  contextOverflowRecovered = false,
  session?: PromptSession,
  modelOverride?: string,
  turnOptions: TurnExecutionOptions = {},
  reasoningOverride?: StoredReasoningSetting,
): Promise<TurnResult> {
  // The controller is replaced when an idle-stall retry needs a live signal
  // after aborting a hung stream, so both it and the cause are mutable.
  let abortController = new AbortController();
  let abortCause = createUserAbortCause();
  let status: TurnStatus = 'failed';
  let abortReason: TurnResult['abortReason'];
  let resume: TurnResult['resume'];
  const turnState = createTurnExecutionState();
  callbacks.onEvent?.(agentEvent({type: 'turn_start', request: value}));
  callbacks.setBusy(true);
  callbacks.setAbortController?.(abortController);
  if (!retryingExistingRequest) callbacks.addMessage({role: 'user', text: displayValue ?? value});
  let turnDeadline: AbsoluteDeadline | undefined;
  const turnStartedAt = Date.now();
  const turnDeadlineMs = turnOptions.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
  try {
    // Retries are one logical turn and therefore share coordinator admission and
    // the workspace mutation lease, including quarantined lingering work. A
    // goal supervisor may pass one shared scope so every physical turn of the
    // logical goal shares the same lease.
    const turnScope: {executionScope?: TurnExecutionScope} = turnOptions.sharedTurnScope ?? {};
    const turnBudget = mainTurnBudget();
    // Turn-scoped provider-usage anchor (Pillar 1.1): context estimation prefers
    // real usage from the last completed step, with chars/4 estimates only for
    // trailing messages. Shared across attempts and invalidated by compaction.
    const usageAnchor: {current: ContextUsageAnchor | undefined} = {current: undefined};
    // Turn-wide execution budget (RH-003): one authoritative counter of
    // underlying tool executions, shared across retries and recovery slices so
    // the global limit cannot be reset or exceeded. The slice budget caps the
    // current slice (main phase or one recovery slice): it is shared by every
    // attempt in that slice and reset only when a new slice is admitted, so a
    // provider retry inside a rescue can never re-arm the slice cap (C2).
    const globalBudget = createToolExecutionBudget();
    const sliceBudget = createToolExecutionBudget();
    // Turn-wide work state: persists across provider retries and recovery
    // slices so mutation/validation evidence accumulates correctly. When the
    // goal supervisor continues a logical goal, cumulative evidence (tasks,
    // mutations, carried validation) is hydrated so a fresh physical turn
    // cannot complete while carried work remains.
    const goal = createSessionGoal(value);
    if (turnOptions.goalContext) seedCarriedGoalEvidence(goal, turnOptions.goalContext.carried);
    // Completion policy is intent-sensitive (implement/fix/test expect
    // post-mutation validation); the turn-wide state carries the classified intent.
    turnState.intent = goal.intent;
    let activeOptions = turnOptions;
    let attempt = retryAttempt;
    let overflowRetries = contextOverflowRecovered ? 1 : 0;
    let overflowShrinkFactor = contextOverflowRecovered ? OVERFLOW_SHRINK_FACTOR : 1;
    let stepsUsedAtLastRetry = 0;
    let retrying = retryingExistingRequest;
    // The attempt machinery runs against quarantinable callbacks so an
    // abort-ignoring stream that outlives forced settlement cannot mutate the
    // finished turn's UI, conversation, or session state.
    const {callbacks: attemptCallbacks, quarantine} = createQuarantinableCallbacks(callbacks);
    while (true) {
      // Absolute main-turn deadline (RH-004): distinct from the idle timer, it
      // bounds total turn elapsed time so a stream of busy tools cannot defer
      // it. Recreated per attempt with the remaining wall-clock budget and bound
      // to the current attempt's controller — an idle-stall retry replaces the
      // controller and must not trip this deadline early via the old signal.
      turnDeadline = createAbsoluteDeadline({
        timeoutMs: Math.max(0, turnDeadlineMs - (Date.now() - turnStartedAt)),
        signal: abortController.signal,
        onTimeout: () => {
          if (abortController.signal.aborted) return;
          callbacks.onEvent?.(agentEvent({type: 'timeout', phase: 'turn', timeoutMs: turnDeadlineMs}));
          abortForTurn(abortCause, {kind: 'turn-deadline', timeoutMs: turnDeadlineMs}, abortController, `haze turn exceeded the ${turnDeadlineMs}ms absolute deadline.`);
        },
      });
      const cleanup = createAttemptCleanupRegistry();
      const result = await awaitAttemptWithForcedSettlement(runAgentAttempt({value, contextFiles, callbacks: attemptCallbacks, retryAttempt: attempt, retryingExistingRequest: retrying, overflowShrinkFactor, overflowRetries, progressSinceLastRetry: turnState.stepsUsed > stepsUsedAtLastRetry, session, modelOverride, reasoningOverride, abortController, turnOptions: activeOptions, turnScope, turnState, turnBudget, globalBudget, sliceBudget, goal, abortCause, cleanup, remainingTurnDeadlineMs: () => Math.max(0, turnDeadlineMs - (Date.now() - turnStartedAt)), usageAnchor}), {
        abortController,
        cleanup,
        quarantine,
        onForced: tornDown => {
          // The attempt ignored cancellation past the grace window: settle the
          // turn ourselves, truthfully reporting whether teardown completed.
          turnState.aborted = true;
          callbacks.debugLog(`attempt ignored cancellation; forced settlement after grace (teardown ${tornDown ? 'completed' : 'still settling'})`);
          callbacks.addMessage({role: 'system', text: abortCause.kind === 'turn-deadline'
            ? `Turn stopped: the ${formatIdleMinutes(abortCause.timeoutMs ?? turnDeadlineMs)} turn budget elapsed before the model finished.${tornDown ? '' : ' Some background teardown is still settling.'} Completed steps are preserved in the conversation; send a follow-up to continue.`
            : 'Thinking aborted. You can type again.'});
          return {status: 'aborted', abortReason: abortCause.kind === 'turn-deadline' ? 'turn-deadline' : 'user'};
        },
      });
      turnDeadline.clear();
      turnDeadline = undefined;
      status = result.status;
      abortReason = result.abortReason;
      resume = result.resume;
      if (result.retry) {
        attempt = result.retry.attempt;
        if (result.retry.overflowShrinkFactor != null) {
          overflowRetries += 1;
          overflowShrinkFactor = result.retry.overflowShrinkFactor;
        }
        stepsUsedAtLastRetry = turnState.stepsUsed;
        retrying = true;
        if (result.retry.freshController) {
          // The idle stall aborted the previous controller to kill the hung
          // stream; the retry needs a live one (and a fresh 'user' cause).
          abortController = new AbortController();
          abortCause = createUserAbortCause();
          callbacks.setAbortController?.(abortController);
        }
        if (result.retry.delayMs > 0) await abortableDelay(result.retry.delayMs, abortController.signal);
        if (abortController.signal.aborted) { status = 'aborted'; break; }
        continue;
      }
      // Bounded recovery slice (length-continuation, rescue, or goal
      // continuation); see recoverySlices.ts. Abort is re-checked before and
      // within the slice.
      if (result.recovery && !abortController.signal.aborted) {
        activeOptions = startRecoverySlice(result.recovery, {turnState, sliceBudget, options: activeOptions}, callbacks.debugLog);
        retrying = true;
        continue;
      }
      break;
    }
    projectGoalEvidence(turnState, goal);
    const evidence = toCompletionEvidence(turnState);
    const checkpoint: GoalCheckpoint = {
      goalId: turnOptions.goalContext?.goalId ?? goal.id, request: value,
      cycle: turnOptions.goalContext?.cycle ?? 1, mutationCount: goal.mutationCount,
      validationOutcome: turnState.validationOutcome, taskCounts: taskCountsOf(goal.taskProgress),
      progressSignature: goalCheckpointSignature({mutationCount: goal.mutationCount, validationOutcome: turnState.validationOutcome, taskCounts: taskCountsOf(goal.taskProgress)}),
      noProgressCount: turnOptions.goalContext?.noProgressCount ?? 0,
      requestHash: turnOptions.goalContext?.requestHash, intent: goal.normalizedIntent,
      ...(turnState.redPair !== 'satisfied' && goal.redEvidence ? {redEvidence: {...goal.redEvidence}} : {}),
      ...(turnState.validationKind ? {validationKind: turnState.validationKind} : {}),
    };
    return {status, evidence, ...(status !== 'complete' ? {checkpoint} : {}), ...(abortReason ? {abortReason} : {}), ...(resume ? {resume} : {})};
  } finally {
    turnDeadline?.clear();
    // RT-05: persist an explicit cause for unexplained outcomes in the ledger
    // (no --debug required) and tell the user when a turn dies silently — the
    // live session saw a 20s goal fail with zero assistant output and no
    // timeout/retry events, forcing the user to re-send the prompt.
    const turnEndReason = status === 'failed' ? describeTurnFailure(turnState, callbacks.getLastAssistantText()) : undefined;
    if (turnEndReason === 'model-returned-no-output') {
      callbacks.addMessage({role: 'system', text: 'The model returned no output for this turn. Send the request again, or retry after a moment; completed work is preserved in the conversation.'});
    }
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status, evidence: toCompletionEvidence(turnState), ...(turnEndReason ? {reason: turnEndReason} : {})}));

    callbacks.setAbortController?.(null);
    callbacks.setBusyLabel?.(modelThinkingLabel(undefined));
    callbacks.setBusy(false);
  }
}
