import type {ContextFile} from '../../../config/contextFiles.js';
import {closeMcpClients, type LoadedMcpTools} from '../../../llm/mcp.js';
import type {LspPool} from '../../../llm/lsp/pool.js';
import type {PromptSession} from '../../../llm/systemPrompt.js';
import type {TurnExecutionScope} from '../../../llm/requestContext.js';
import type {ToolExecutionBudgetState, TurnBudget} from '../../../core/agent/budgets.js';
import type {ContextUsageAnchor} from '../../../core/agent/contextBudget.js';
import type {TurnExecutionState} from '../../../core/agent/completionController.js';
import type {SessionGoal} from '../../../core/agent/goalPolicy.js';
import {modelThinkingLabel} from '../../../utils/modelName.js';
import {normalizeAssistantText} from './assistantText.js';
import {createToolGroupRenderer} from './toolGroupRenderer.js';
import {prepareAttempt} from './attemptSetup.js';
import {createAttemptLoopState, runAttemptStream} from './streamLoop.js';
import {createStreamStallGuard, type AttemptSalvage, type StreamStallGuard} from './stallRecovery.js';
import {finalizeAttemptOutcome, handleAttemptFailure, type AgentAttemptResult} from './attemptOutcome.js';
import type {AttemptCleanupRegistry} from './attemptLifecycle.js';
import {ATTEMPT_TEARDOWN_BOUND_MS} from './attemptLifecycle.js';
import type {TurnAbortCause} from './abortCause.js';
import type {StoredReasoningSetting} from '../../../core/agent/reasoningPolicy.js';
import type {StreamCallbacks, TurnExecutionOptions} from '../streaming.js';

export interface AgentAttemptInput {
  value: string;
  contextFiles: ContextFile[];
  callbacks: StreamCallbacks;
  retryAttempt: number;
  retryingExistingRequest: boolean;
  /** Multiplier for the message-token budget after context-overflow retries (1 = none; Pillar 1.4). */
  overflowShrinkFactor: number;
  /** Context-overflow retries already consumed by this turn (Pillar 1.4). */
  overflowRetries: number;
  /** Whether this attempt runs after progress since the previous retry (Pillar 1.3 pool reset). */
  progressSinceLastRetry: boolean;
  session: PromptSession | undefined;
  modelOverride: string | undefined;
  /** Run-scoped reasoning level/sentinel (CLI `--reasoning`); overrides the stored setting for this run. */
  reasoningOverride: StoredReasoningSetting | undefined;
  abortController: AbortController;
  turnOptions: TurnExecutionOptions;
  turnScope: {executionScope?: TurnExecutionScope};
  turnState: TurnExecutionState;
  turnBudget: TurnBudget;
  globalBudget: ToolExecutionBudgetState;
  /** Slice execution budget shared by every attempt in the current slice (main phase or one recovery slice); reset when a new slice is admitted. */
  sliceBudget: ToolExecutionBudgetState;
  goal: SessionGoal;
  abortCause: TurnAbortCause;
  /** Exactly-once teardown registry; shared with the turn's forced-settlement path. */
  cleanup: AttemptCleanupRegistry;
  remainingTurnDeadlineMs: () => number;
  /** Turn-scoped usage anchor for provider-usage-backed context estimation (Pillar 1.1). */
  usageAnchor: {current: ContextUsageAnchor | undefined};
}

/**
 * Run one agent attempt end to end: setup (`attemptSetup`), the stream loop
 * (`streamLoop`), then terminal classification and recovery decisions
 * (`attemptOutcome`). Failures are classified from the abort cause and error
 * in one catch; MCP clients, the LSP pool, the stall guard, and the tool
 * display are always torn down.
 */
export async function runAgentAttempt(input: AgentAttemptInput): Promise<AgentAttemptResult> {
  const {value, contextFiles, callbacks, retryingExistingRequest, session, modelOverride, reasoningOverride, abortController, turnOptions, turnScope, turnState, turnBudget, globalBudget, sliceBudget, goal, abortCause, cleanup, remainingTurnDeadlineMs, usageAnchor} = input;
  // Pillar 1.3: progress since the previous retry resets the shared retry pool
  // (mirrors a per-burst budget), applied to both the stall guard's retry
  // eligibility and the failure classification below.
  const retryAttempt = input.progressSinceLastRetry && input.retryAttempt > 0 ? 0 : input.retryAttempt;
  callbacks.setBusyLabel?.(modelThinkingLabel(undefined));
  let loadedMcp: LoadedMcpTools | undefined;
  let lspPool: LspPool | undefined;
  let mcpClosed = false;
  let lspClosed = false;
  const toolDisplay = createToolGroupRenderer({addMessage: callbacks.addMessage, updateMessage: callbacks.updateMessage, debugLog: callbacks.debugLog, onEvent: callbacks.onEvent, log: callbacks.log});
  // Teardown is registered, not inline: whichever runs first — this attempt's
  // own finally or the turn-level forced settlement after an abort-ignoring
  // stream — performs it exactly once (bounded), the other becomes a no-op.
  cleanup.register(async () => {
    const closes: Promise<unknown>[] = [];
    if (loadedMcp?.clients.length && !mcpClosed) {
      mcpClosed = true;
      closes.push(closeMcpClients(loadedMcp.clients));
    }
    if (lspPool && !lspClosed) {
      lspClosed = true;
      closes.push(lspPool.close());
    }
    stallGuard?.clear();
    toolDisplay.stopToolTimer();
    await Promise.allSettled(closes);
  });
  const salvage: AttemptSalvage = {requestMessages: [], accumulated: []};
  let stallGuard: StreamStallGuard | undefined;
  let setup: Awaited<ReturnType<typeof prepareAttempt>> | undefined;
  try {
    setup = await prepareAttempt({value, contextFiles, callbacks, retryingExistingRequest, overflowShrinkFactor: input.overflowShrinkFactor, session, modelOverride, reasoningOverride, abortController, turnOptions, turnScope, turnBudget, globalBudget, sliceBudget, goal, onContextFileRead: path => toolDisplay.addContextFileRead(path), usageAnchor});
    if (!setup) return {status: 'failed'};
    const attemptSetupResult = setup;
    loadedMcp = setup.loadedMcp;
    lspPool = setup.lspPool;
    salvage.requestMessages = setup.requestMessages;

    const loopState = createAttemptLoopState(normalizeAssistantText(callbacks.getLastAssistantText()), setup.contextFiles, callbacks);
    stallGuard = createStreamStallGuard({
      controller: abortController,
      abortCause,
      retryAttempt,
      maxRetries: attemptSetupResult.modelRetries,
      classifyEmission: () => loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted ? 'text' : loopState.inFlightTools.size > 0 ? 'tool' : 'none',
      isToolInFlight: () => loopState.inFlightTools.size > 0,
      provider: () => attemptSetupResult.runtime.config.providerName,
      model: () => attemptSetupResult.runtime.config.modelName,
      workPhase: () => goal.phase,
      stepsUsed: () => turnState.stepsUsed,
      onEvent: callbacks.onEvent,
      log: callbacks.log,
      debugLog: callbacks.debugLog,
    });

    const stream = await runAttemptStream({setup, callbacks, abortController, retryAttempt, recoverySlice: turnOptions.recoverySlice, turnState, turnBudget, globalBudget, goal, stallGuard, loopState, toolDisplay, salvage, usageAnchor});
    return finalizeAttemptOutcome({value, callbacks, abortController, turnOptions, turnState, turnBudget, goal, remainingTurnDeadlineMs, stream, retryAttempt, overflowRetries: input.overflowRetries});
  } catch (error) {
    return handleAttemptFailure({value, callbacks, abortController, turnState, retryAttempt, progressSinceLastRetry: input.progressSinceLastRetry, overflowRetries: input.overflowRetries, abortCause, stallGuard, salvage, error, maxRetries: setup?.modelRetries, retryBaseDelayMs: setup?.retryBaseDelayMs, goal, turnOptions});
  } finally {
    await cleanup.closeOnce(ATTEMPT_TEARDOWN_BOUND_MS);
    toolDisplay.finalizeToolGroup();
  }
}
