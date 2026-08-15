import type {ContextFile} from '../../../config/contextFiles.js';
import {closeMcpClients, type LoadedMcpTools} from '../../../llm/mcp.js';
import type {LspPool} from '../../../llm/lsp/pool.js';
import type {PromptSession} from '../../../llm/systemPrompt.js';
import type {TurnExecutionScope} from '../../../llm/requestContext.js';
import type {ToolExecutionBudgetState, TurnBudget} from '../../../core/agent/budgets.js';
import type {TurnExecutionState} from '../../../core/agent/completionController.js';
import type {SessionGoal} from '../../../core/agent/goalPolicy.js';
import {modelThinkingLabel} from '../../../utils/modelName.js';
import {normalizeAssistantText} from './assistantText.js';
import {createToolGroupRenderer} from './toolGroupRenderer.js';
import {prepareAttempt} from './attemptSetup.js';
import {createAttemptLoopState, runAttemptStream} from './streamLoop.js';
import {createStreamStallGuard, type AttemptSalvage, type StreamStallGuard} from './stallRecovery.js';
import {finalizeAttemptOutcome, handleAttemptFailure, type AgentAttemptResult} from './attemptOutcome.js';
import type {TurnAbortCause} from './abortCause.js';
import type {StreamCallbacks, TurnExecutionOptions} from '../streaming.js';

export interface AgentAttemptInput {
  value: string;
  contextFiles: ContextFile[];
  callbacks: StreamCallbacks;
  retryAttempt: number;
  retryingExistingRequest: boolean;
  contextOverflowRecovered: boolean;
  session: PromptSession | undefined;
  modelOverride: string | undefined;
  abortController: AbortController;
  turnOptions: TurnExecutionOptions;
  turnScope: {executionScope?: TurnExecutionScope};
  turnState: TurnExecutionState;
  turnBudget: TurnBudget;
  globalBudget: ToolExecutionBudgetState;
  goal: SessionGoal;
  abortCause: TurnAbortCause;
  remainingTurnDeadlineMs: () => number;
}

/**
 * Run one agent attempt end to end: setup (`attemptSetup`), the stream loop
 * (`streamLoop`), then terminal classification and recovery decisions
 * (`attemptOutcome`). Failures are classified from the abort cause and error
 * in one catch; MCP clients, the LSP pool, the stall guard, and the tool
 * display are always torn down.
 */
export async function runAgentAttempt(input: AgentAttemptInput): Promise<AgentAttemptResult> {
  const {value, contextFiles, callbacks, retryAttempt, retryingExistingRequest, contextOverflowRecovered, session, modelOverride, abortController, turnOptions, turnScope, turnState, turnBudget, globalBudget, goal, abortCause, remainingTurnDeadlineMs} = input;
  callbacks.setBusyLabel?.(modelThinkingLabel(undefined));
  let loadedMcp: LoadedMcpTools | undefined;
  let lspPool: LspPool | undefined;
  const toolDisplay = createToolGroupRenderer({addMessage: callbacks.addMessage, updateMessage: callbacks.updateMessage, debugLog: callbacks.debugLog, onEvent: callbacks.onEvent, log: callbacks.log});
  const salvage: AttemptSalvage = {requestMessages: [], accumulated: []};
  let stallGuard: StreamStallGuard | undefined;
  try {
    const setup = await prepareAttempt({value, contextFiles, callbacks, retryingExistingRequest, contextOverflowRecovered, session, modelOverride, abortController, turnOptions, turnScope, turnBudget, globalBudget, goal, onContextFileRead: path => toolDisplay.addContextFileRead(path)});
    if (!setup) return {status: 'failed'};
    loadedMcp = setup.loadedMcp;
    lspPool = setup.lspPool;
    salvage.requestMessages = setup.requestMessages;

    const loopState = createAttemptLoopState(normalizeAssistantText(callbacks.getLastAssistantText()), setup.contextFiles, callbacks);
    stallGuard = createStreamStallGuard({
      controller: abortController,
      abortCause,
      retryAttempt,
      classifyEmission: () => loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted ? 'text' : loopState.inFlightTools.size > 0 ? 'tool' : 'none',
      isToolInFlight: () => loopState.inFlightTools.size > 0,
      provider: () => setup.runtime.config.providerName,
      model: () => setup.runtime.config.modelName,
      workPhase: () => goal.phase,
      stepsUsed: () => turnState.stepsUsed,
      onEvent: callbacks.onEvent,
      log: callbacks.log,
      debugLog: callbacks.debugLog,
    });

    const stream = await runAttemptStream({setup, callbacks, abortController, retryAttempt, recoverySlice: turnOptions.recoverySlice, turnState, turnBudget, globalBudget, goal, stallGuard, loopState, toolDisplay, salvage});
    return finalizeAttemptOutcome({value, callbacks, abortController, turnOptions, turnState, turnBudget, goal, remainingTurnDeadlineMs, stream});
  } catch (error) {
    return handleAttemptFailure({value, callbacks, abortController, turnState, retryAttempt, contextOverflowRecovered, abortCause, stallGuard, salvage, error});
  } finally {
    if (loadedMcp?.clients.length) await closeMcpClients(loadedMcp.clients);
    if (lspPool) await lspPool.close();
    stallGuard?.clear();
    toolDisplay.stopToolTimer();
    toolDisplay.finalizeToolGroup();
  }
}
