import type {LlmLog} from '../../core/log/llmLog.js';
import type {ModelMessage} from 'ai';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import type {ImageAttachment} from '../../core/attachments/imageAttachments.js';
import {type BlessedPath} from '../../core/attachments/readBlessings.js';
import {createTurnExecutionState, recordGoalContinuation, toCompletionEvidence} from '../../core/agent/completionController.js';
import type {TurnCompletionEvidence} from '../../core/agent/completionController.js';
import {createSessionGoal} from '../../core/agent/goalPolicy.js';
import {seedCarriedGoalEvidence} from '../../core/agent/workState.js';
import type {ValidationOutcome, WorkTaskProgress, WorkState} from '../../core/agent/workState.js';
import {createToolExecutionBudget, mainTurnBudget, DEFAULT_TURN_DEADLINE_MS} from '../../core/agent/budgets.js';
import {createAbsoluteDeadline, type AbsoluteDeadline} from '../../core/deadline.js';
import type {SubagentOverrides, TurnExecutionScope} from '../../llm/requestContext.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import type {IncompleteGoalResume} from './streaming/goalCheckpoint.js';
import {abortableDelay, type TokenUsage} from './streaming/turnRuntime.js';
import type {ToolDisplayDiff} from './streaming/toolGroupRenderer.js';
import {abortForTurn, createUserAbortCause} from './streaming/abortCause.js';
import {runAgentAttempt} from './streaming/agentAttempt.js';
import {awaitAttemptWithForcedSettlement, createAttemptCleanupRegistry, createQuarantinableCallbacks} from './streaming/attemptLifecycle.js';
import {formatIdleMinutes} from './streaming/stallRecovery.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number; toolCount?: number; toolDiffs?: ToolDisplayDiff[]};

export type TurnStatus = 'complete' | 'aborted' | 'failed';

/** Authoritative outcome of a turn, so callers (esp. headless/CI) need not sniff message texts. */
export interface TurnResult {
  status: TurnStatus;
  /** Bounded, safe completion evidence (no raw commands/output). Additive. */
  evidence?: TurnCompletionEvidence;
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
  carried: {mutationCount: number; validationOutcome: ValidationOutcome; taskProgress?: WorkTaskProgress};
  /** Consecutive no-progress physical turns at goal level (diagnostics). */
  noProgressCount: number;
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
): Promise<TurnResult> {
  // The controller is replaced when an idle-stall retry needs a live signal
  // after aborting a hung stream, so both it and the cause are mutable.
  let abortController = new AbortController();
  let abortCause = createUserAbortCause();
  let status: TurnStatus = 'failed';
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
    let overflowRecovered = contextOverflowRecovered;
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
      const result = await awaitAttemptWithForcedSettlement(runAgentAttempt({value, contextFiles, callbacks: attemptCallbacks, retryAttempt: attempt, retryingExistingRequest: retrying, contextOverflowRecovered: overflowRecovered, session, modelOverride, abortController, turnOptions: activeOptions, turnScope, turnState, turnBudget, globalBudget, sliceBudget, goal, abortCause, cleanup, remainingTurnDeadlineMs: () => Math.max(0, turnDeadlineMs - (Date.now() - turnStartedAt))}), {
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
          return {status: 'aborted'};
        },
      });
      turnDeadline.clear();
      turnDeadline = undefined;
      status = result.status;
      resume = result.resume;
      if (result.retry) {
        attempt = result.retry.attempt;
        overflowRecovered = result.retry.contextOverflowRecovered;
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
      // continuation). Length/rescue credits are single-use, so a slice cannot
      // trigger another of the same kind; goal continuation is repeatable but
      // progress-guarded and counts against the shared turn budget. Abort is
      // re-checked before and within the slice.
      if (result.recovery && !abortController.signal.aborted) {
        const rec = result.recovery;
        if (rec.kind === 'length') { turnState.lengthCreditUsed = true; turnState.lengthRecoveriesAttempted += 1; } else if (rec.kind === 'rescue') turnState.rescueUsed = true; else recordGoalContinuation(turnState);
        // A new slice gets a fresh execution allowance, clamped once here; the
        // slice budget persists across provider retries within the slice (C2).
        sliceBudget.started = 0;
        sliceBudget.exceeded = false;
        activeOptions = {...activeOptions, ephemeralControl: rec.control, recoverySlice: {kind: rec.kind, maxSteps: rec.slice.maxSteps, maxToolCalls: rec.slice.maxToolCalls}};
        retrying = true;
        callbacks.debugLog(`starting ${rec.kind} recovery slice: ${rec.slice.maxSteps} steps / ${rec.slice.maxToolCalls} tool calls`);
        continue;
      }
      break;
    }
    const evidence = toCompletionEvidence(turnState);
    return {status, evidence, ...(resume ? {resume} : {})};
  } finally {
    turnDeadline?.clear();
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status, evidence: toCompletionEvidence(turnState)}));
    callbacks.setAbortController?.(null);
    callbacks.setBusyLabel?.(modelThinkingLabel(undefined));
    callbacks.setBusy(false);
  }
}
