import {ToolLoopAgent, isStepCount, type ModelMessage} from 'ai';
import {agentEvent} from '../../../core/agent/events.js';
import {type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {estimateValueTokens} from '../../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls} from '../../../core/agent/requestAssembly.js';
import {type TurnExecutionState} from '../../../core/agent/completionController.js';
import {DEFAULT_MAX_OUTPUT_TOKENS, type ToolExecutionBudgetState, type TurnBudget} from '../../../core/agent/budgets.js';
import {toolsContextFor} from '../../../llm/tools/toolContext.js';
import {busyToolLabel, toolCallSummary} from '../formatters.js';
import type {StreamCallbacks, TurnExecutionOptions} from '../streaming.js';
import {sanitizeAssistantText, assistantDisplayText, normalizeAssistantText, shouldStartAssistantStream} from './assistantText.js';
import {finalizeAssistantSegment, finalizePendingAssistantBeforeTool} from './assistantSegments.js';
import {handleToolErrorPart, handleToolResultPart, type AttemptStreamPart} from './toolPartHandlers.js';
import {createPrepareStep, createRepairToolCall} from './prepareStep.js';
import {type NativeToolCall, type ToolGroupRenderer} from './toolGroupRenderer.js';
import {applyStepToolResultState, initialToolResultState, type ToolResultState} from './toolResultState.js';
import {extractUsage, logEntry, stepCacheMetrics} from './turnRuntime.js';
import type {AttemptSalvage, StreamStallGuard} from './stallRecovery.js';
import type {AttemptSetup} from './attemptSetup.js';
import type {ContextFile} from '../../../config/contextFiles.js';

/**
 * Mutable per-attempt loop state. Created before the stall guard so its
 * `classifyEmission` can read what the stalled step emitted, and consumed by
 * the stream part handlers, `prepareStep`, and the attempt outcome.
 */
export interface AttemptLoopState {
  /** Cumulative assistant text across all segments of this attempt. */
  assistantText: string;
  currentAssistantText: string;
  assistantStarted: boolean;
  currentAssistantId: string;
  assistantStartedAt: number;
  streamError: unknown;
  streamFinished: boolean;
  finishReason: string | undefined;
  lastToolOk: boolean | undefined;
  pendingMalformedToolName: string | undefined;
  unresolvedMalformedToolName: string | undefined;
  /** Per-attempt (not per-turn) recovery counter: a transient retry gets a fresh map. Bounded across the whole turn by MAIN_TOOL_CALL_LIMIT. */
  malformedRecoveryAttempts: Map<string, number>;
  toolResultState: ToolResultState;
  /** Tool calls currently executing; a busy tool wave defers the idle timer. */
  inFlightTools: Set<string>;
  startedTools: Map<string, number>;
  latestToolCalls: Map<string, NativeToolCall>;
  /** Normalized assistant texts already shown this session (duplicate suppression). */
  visibleAssistantTexts: Set<string>;
  rememberVisibleAssistantText: (text: string) => void;
  /** Context files active for this attempt; grows when tool outputs surface scoped instructions. */
  contextFiles: ContextFile[];
}

export function createAttemptLoopState(previousAssistantText: string, contextFiles: ContextFile[], callbacks: Pick<StreamCallbacks, 'setLastAssistantText'>): AttemptLoopState {
  const visibleAssistantTexts = new Set(previousAssistantText ? [previousAssistantText] : []);
  return {
    assistantText: '',
    currentAssistantText: '',
    assistantStarted: false,
    currentAssistantId: `assistant-${Date.now()}`,
    assistantStartedAt: Date.now(),
    streamError: undefined,
    streamFinished: false,
    finishReason: undefined,
    lastToolOk: undefined,
    pendingMalformedToolName: undefined,
    unresolvedMalformedToolName: undefined,
    malformedRecoveryAttempts: new Map<string, number>(),
    toolResultState: initialToolResultState(),
    inFlightTools: new Set<string>(),
    startedTools: new Map<string, number>(),
    latestToolCalls: new Map<string, NativeToolCall>(),
    visibleAssistantTexts,
    rememberVisibleAssistantText: (text: string) => {
      const normalized = normalizeAssistantText(text);
      if (!normalized) return;
      visibleAssistantTexts.add(normalized);
      callbacks.setLastAssistantText(text);
    },
    contextFiles,
  };
}

/** What the completed stream tells the attempt outcome (classification evidence). */
export interface AttemptStreamOutcome {
  finishReason: string | undefined;
  lastToolOk: boolean | undefined;
  assistantText: string;
  sawToolCall: boolean;
  unresolvedMalformedToolName: string | undefined;
  unresolvedToolInputError: boolean;
}

export interface AttemptStreamDeps {
  setup: AttemptSetup;
  callbacks: StreamCallbacks;
  abortController: AbortController;
  retryAttempt: number;
  recoverySlice: TurnExecutionOptions['recoverySlice'];
  turnState: TurnExecutionState;
  turnBudget: TurnBudget;
  globalBudget: ToolExecutionBudgetState;
  goal: SessionGoal;
  stallGuard: StreamStallGuard;
  loopState: AttemptLoopState;
  toolDisplay: ToolGroupRenderer;
  salvage: AttemptSalvage;
}

function applyStreamPart(deps: AttemptStreamDeps, part: AttemptStreamPart) {
  const {loopState, callbacks, toolDisplay, setup} = deps;
  switch (part.type) {
    case 'text-delta': {
      callbacks.setBusyLabel?.(setup.thinkingLabel);
      toolDisplay.startFreshToolGroup();
      const delta = sanitizeAssistantText(part.text as string);
      loopState.assistantText += delta;
      loopState.currentAssistantText += delta;
      const displayText = assistantDisplayText(loopState.currentAssistantText);
      if (!loopState.assistantStarted && !shouldStartAssistantStream(displayText, loopState.assistantStartedAt)) break;
      if (!loopState.assistantStarted) {
        loopState.assistantStarted = true;
        loopState.assistantStartedAt = Date.now();
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: loopState.currentAssistantId, role: 'assistant'}));
        callbacks.addMessage({id: loopState.currentAssistantId, role: 'assistant', text: displayText, streaming: true, startedAt: loopState.assistantStartedAt});
      } else {
        callbacks.onEvent?.(agentEvent({type: 'message_update', id: loopState.currentAssistantId, text: displayText}));
        callbacks.updateMessage(loopState.currentAssistantId, {text: displayText});
      }
      break;
    }
    case 'tool-input-start': {
      finalizePendingAssistantBeforeTool(deps);
      const toolCall = {toolCallId: part.id as string, toolName: part.toolName as string, input: {}};
      loopState.latestToolCalls.set(part.id as string, toolCall);
      loopState.inFlightTools.add(part.id as string);
      callbacks.setBusyLabel?.(busyToolLabel(part.toolName as string, {}));
      toolDisplay.ensureToolItem(toolCall);
      break;
    }
    case 'tool-call': {
      finalizePendingAssistantBeforeTool(deps);
      const toolCall = {toolCallId: part.toolCallId as string, toolName: part.toolName as string, input: part.input};
      loopState.latestToolCalls.set(part.toolCallId as string, toolCall);
      // Tool execution begins only after its complete input has parsed and validated.
      loopState.startedTools.set(part.toolCallId as string, Date.now());
      callbacks.setBusyLabel?.(busyToolLabel(part.toolName as string, part.input));
      toolDisplay.ensureToolItem(toolCall).summary = toolCallSummary(part.toolName as string, part.input);
      toolDisplay.updateToolGroup(true);
      break;
    }
    case 'tool-result': {
      handleToolResultPart(deps, part);
      break;
    }
    case 'tool-error': {
      handleToolErrorPart(deps, part);
      break;
    }
    case 'error':
      loopState.streamError = part.error;
      callbacks.debugLog(`stream error: ${part.error instanceof Error ? part.error.message : String(part.error)}`);
      break;
    case 'finish':
      loopState.streamFinished = true;
      loopState.finishReason = part.finishReason as string | undefined;
      callbacks.debugLog(`ToolLoopAgent finished: ${part.finishReason}`);
      break;
    default:
      break;
  }
}

/** Await the agent's response messages and commit the completed conversation; salvage to the last completed step on a post-stream failure. */
async function commitStreamResult(deps: AttemptStreamDeps, result: {responseMessages: PromiseLike<ModelMessage[]>}) {
  const {loopState, callbacks, salvage} = deps;
  if (loopState.streamError && !loopState.streamFinished) {
    void Promise.resolve(result.responseMessages).catch(() => undefined);
    throw loopState.streamError;
  }

  try {
    const responseMessages = await result.responseMessages;
    const completedConversation = [...stripSyntheticControls(salvage.requestMessages), ...responseMessages];
    callbacks.setConversation(compactToolHistory(completedConversation).messages);
  } catch (error) {
    if (salvage.accumulated.length > 0) {
      callbacks.setConversation(compactToolHistory([...stripSyntheticControls(salvage.requestMessages), ...salvage.accumulated]).messages);
    }
    const text = error instanceof Error ? error.message : String(error);
    const benignTerminatedAfterStream = text === 'terminated' && (loopState.streamFinished || loopState.assistantText.trim().length > 0 || loopState.latestToolCalls.size > 0);
    if (!benignTerminatedAfterStream) throw loopState.streamError ?? error;
    callbacks.debugLog(`ignored post-stream response error: ${text}`);
  }

  if (loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted) {
    finalizeAssistantSegment(loopState, callbacks);
  } else if (loopState.latestToolCalls.size > 0) {
    callbacks.addMessage({role: 'system', text: 'Tool work ended without a substantive final answer.'});
  }
}

/**
 * Drive one attempt's `ToolLoopAgent` stream: construct the agent (repair,
 * prepareStep, step observers), consume every stream part, and commit the
 * completed conversation. Throws the stream error so the attempt orchestrator
 * classifies failures (abort cause, retry pool, recovery) in one place.
 */
export async function runAttemptStream(deps: AttemptStreamDeps): Promise<AttemptStreamOutcome> {
  const {setup, callbacks, loopState, turnState, globalBudget, stallGuard, salvage, retryAttempt, abortController} = deps;
  const {sliceTools, stepCap, systemPrompt, inputBreakdown, providerSettings, omitMaxOutputTokens, toolExecutionContext, requestMessages} = setup;

  const agent = new ToolLoopAgent({
    id: 'haze-main',
    model: setup.runtime.model,
    instructions: systemPrompt,
    tools: sliceTools,
    ...(!omitMaxOutputTokens ? {maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS} : {}),
    ...providerSettings,
    stopWhen: isStepCount(stepCap),
    runtimeContext: toolExecutionContext,
    toolsContext: toolsContextFor(sliceTools, toolExecutionContext) as never,
    experimental_repairToolCall: createRepairToolCall(deps),
    prepareStep: createPrepareStep(deps),
    onStepStart({stepNumber}) {
      callbacks.onEvent?.(agentEvent({type: 'step_start', attempt: retryAttempt + 1, step: stepNumber + 1}));
    },
    onStepEnd({stepNumber, text, content = [], toolCalls, toolResults, finishReason, usage, response}) {
      // Tool-loop control must advance from this internal callback, which the
      // SDK awaits before prepareStep. Updating it from the public stream can
      // lag behind fast providers and leave the next request read-only.
      loopState.toolResultState = applyStepToolResultState(loopState.toolResultState, content);
      // Turn-wide counters (shared across provider retries and recovery
      // slices) so the global budget cannot reset between attempts. The
      // execution-boundary budget (RH-003) is the authoritative count of
      // underlying executions; sync the turn state to it so blocked calls are
      // not double-counted and recovery math stays consistent.
      turnState.stepsUsed += 1;
      turnState.toolCallsUsed = globalBudget.started;
      if (toolCalls.length > 0 && text.trim().length === 0) turnState.toolOnlyStepsUsed += 1;
      if (Array.isArray(response?.messages) && response.messages.length > 0) salvage.accumulated = response.messages as ModelMessage[];
      const stepUsage = stepCacheMetrics(usage);
      const publicUsage = {
        inputTokens: stepUsage.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: stepUsage.cacheReadTokens,
        cacheWriteTokens: stepUsage.cacheWriteTokens,
        reasoningTokens: stepUsage.reasoningTokens,
      };
      callbacks.onEvent?.(agentEvent({type: 'step_end', attempt: retryAttempt + 1, step: stepNumber + 1, finishReason, toolCallCount: toolCalls.length, usage: publicUsage, ...(response?.modelId ? {responseModel: response.modelId} : {})}));
      logEntry(callbacks.log, {at: new Date().toISOString(), type: 'step', stream: 'main', step: stepNumber, text, finishReason, usage: {inputTokens: stepUsage.inputTokens, outputTokens: usage?.outputTokens, cacheReadTokens: stepUsage.cacheReadTokens || undefined, cacheWriteTokens: stepUsage.cacheWriteTokens || undefined, noCacheTokens: stepUsage.noCacheTokens || undefined, reasoningTokens: stepUsage.reasoningTokens || undefined, cacheHitRatio: stepUsage.cacheHitRatio}});
      callbacks.debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
    },
    onEnd(event) {
      const providerUsage = extractUsage({usage: event.usage});
      callbacks.recordTokenUsage?.({
        inputTokens: providerUsage.inputTokens,
        outputTokens: providerUsage.outputTokens,
        systemPrompt: inputBreakdown.systemPrompt,
        messages: inputBreakdown.messages,
        toolSchemas: inputBreakdown.toolSchemas,
        outputEstimate: estimateValueTokens(event.responseMessages),
        cacheReadTokens: providerUsage.cacheReadTokens,
        cacheWriteTokens: providerUsage.cacheWriteTokens,
        noCacheTokens: providerUsage.noCacheTokens,
        reasoningTokens: providerUsage.reasoningTokens,
        logicalInputEstimate: inputBreakdown.logicalInputEstimate,
        effectiveNonCachedInput: providerUsage.effectiveNonCachedInput,
      });
      const accumulated = [...stripSyntheticControls(requestMessages), ...event.responseMessages];
      const compacted = compactToolHistory(accumulated);
      callbacks.setConversation(compacted.messages);
      callbacks.debugLog(`conversation updated to ${compacted.messages.length} messages by ToolLoopAgent`);
    },
  });

  stallGuard.rearm();
  const result = await agent.stream({messages: requestMessages, abortSignal: abortController.signal});

  for await (const part of result.stream) {
    stallGuard.noteStreamEvent(part.type);
    applyStreamPart(deps, part);
  }

  await commitStreamResult(deps, result);

  return {
    finishReason: loopState.finishReason,
    lastToolOk: loopState.lastToolOk,
    assistantText: loopState.assistantText,
    sawToolCall: loopState.latestToolCalls.size > 0,
    unresolvedMalformedToolName: loopState.unresolvedMalformedToolName,
    unresolvedToolInputError: loopState.unresolvedMalformedToolName != null,
  };
}
