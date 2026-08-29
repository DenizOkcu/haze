import {createHash} from 'node:crypto';
import {ToolLoopAgent, isStepCount, type ModelMessage} from 'ai';
import {agentEvent} from '../../../core/agent/events.js';
import {type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {estimateValueTokens} from '../../../core/agent/contextBudget.js';
import {stripSyntheticControls} from '../../../core/agent/requestAssembly.js';
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
  sawToolCall: boolean;
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
  /** Lightweight cross-epoch history; never retains AI SDK StepResult objects. */
  completedSteps: number;
  generatedToolCalls: number;
  consecutiveToolOnlySteps: number;
  latestRepeatedToolNames: string[];
  seenToolCallFingerprints: Set<string>;
  /** The current epoch rewrote history because the real context budget fired. */
  contextCompactedInEpoch: boolean;
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
    sawToolCall: false,
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
    completedSteps: 0,
    generatedToolCalls: 0,
    consecutiveToolOnlySteps: 0,
    latestRepeatedToolNames: [],
    seenToolCallFingerprints: new Set<string>(),
    contextCompactedInEpoch: false,
  };
}

function toolCallFingerprint(value: unknown): {fingerprint: string; toolName: string} | undefined {
  if (typeof value !== 'object' || value == null) return undefined;
  const call = value as {toolName?: unknown; input?: unknown};
  if (typeof call.toolName !== 'string') return undefined;
  const serialized = JSON.stringify(call.input) ?? 'undefined';
  const digest = createHash('sha256').update(serialized).digest('base64url');
  return {fingerprint: `${call.toolName}:${digest}`, toolName: call.toolName};
}

/** Retain only the policy metadata needed by prepareStep across SDK epochs. */
function recordCompletedStep(loopState: AttemptLoopState, input: {text: string; toolCalls: readonly unknown[]}) {
  const repeated = new Set<string>();
  for (const toolCall of input.toolCalls) {
    const keyed = toolCallFingerprint(toolCall);
    if (!keyed) continue;
    if (loopState.seenToolCallFingerprints.has(keyed.fingerprint)) repeated.add(keyed.toolName);
    loopState.seenToolCallFingerprints.add(keyed.fingerprint);
  }
  loopState.latestRepeatedToolNames = [...repeated];
  loopState.completedSteps += 1;
  loopState.generatedToolCalls += input.toolCalls.length;
  loopState.consecutiveToolOnlySteps = input.toolCalls.length > 0 && input.text.trim().length === 0
    ? loopState.consecutiveToolOnlySteps + 1
    : 0;
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
      loopState.sawToolCall = true;
      const toolCall = {toolCallId: part.id as string, toolName: part.toolName as string, input: {}};
      loopState.latestToolCalls.set(part.id as string, toolCall);
      loopState.inFlightTools.add(part.id as string);
      callbacks.setBusyLabel?.(busyToolLabel(part.toolName as string, {}));
      toolDisplay.ensureToolItem(toolCall);
      break;
    }
    case 'tool-call': {
      finalizePendingAssistantBeforeTool(deps);
      loopState.sawToolCall = true;
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

/** Await one bounded SDK epoch and commit its exact append-only provider history. */
async function commitStreamResult(deps: AttemptStreamDeps, result: {responseMessages: PromiseLike<ModelMessage[]>}): Promise<ModelMessage[]> {
  const {loopState, callbacks, salvage, abortController} = deps;
  if (loopState.streamError && !loopState.streamFinished) {
    void Promise.resolve(result.responseMessages).catch(() => undefined);
    throw loopState.streamError;
  }

  try {
    const responseMessages = await result.responseMessages;
    // Some providers settle responseMessages instead of rejecting when an
    // abort ends the stream. Never commit that partial response as a normal
    // completion: the attempt catch must classify the recorded abort cause.
    if (abortController.signal.aborted) throw abortController.signal.reason ?? new Error('aborted');
    const providerConversation = [...salvage.requestMessages, ...responseMessages];
    // Synthetic controls are request-local and must not enter session state,
    // but every non-control provider message remains byte-for-byte unchanged.
    callbacks.setConversation(stripSyntheticControls(providerConversation));
    return providerConversation;
  } catch (error) {
    if (salvage.accumulated.length > 0) {
      callbacks.setConversation([...stripSyntheticControls(salvage.requestMessages), ...salvage.accumulated]);
    }
    // An idle timeout commonly makes AI SDK responseMessages reject with the
    // generic "terminated" error after one or more completed tool steps. That
    // is not benign: propagate it so model-stream retry/pause recovery runs.
    if (abortController.signal.aborted) throw loopState.streamError ?? error;
    const text = error instanceof Error ? error.message : String(error);
    const benignTerminatedAfterStream = text === 'terminated' && (loopState.streamFinished || loopState.assistantText.trim().length > 0 || loopState.sawToolCall);
    if (!benignTerminatedAfterStream) throw loopState.streamError ?? error;
    callbacks.debugLog(`ignored post-stream response error: ${text}`);
    return [...salvage.requestMessages, ...salvage.accumulated];
  }
}

interface AgentEpochResult {
  providerMessages: ModelMessage[];
  completedSteps: number;
}

/**
 * Run exactly one AI SDK step. Keeping this in a separate async frame makes the
 * ToolLoopAgent, StreamTextResult, and SDK StepResult graph collectible before
 * the next provider request while retaining Vercel's provider/tool machinery.
 */
async function runAgentEpoch(deps: AttemptStreamDeps, requestMessages: ModelMessage[]): Promise<AgentEpochResult> {
  const {setup, callbacks, loopState, turnState, globalBudget, stallGuard, salvage, retryAttempt, abortController} = deps;
  const {sliceTools, systemPrompt, inputBreakdown, providerSettings, omitMaxOutputTokens, toolExecutionContext} = setup;
  const prepare = createPrepareStep(deps);
  const completedBefore = loopState.completedSteps;
  salvage.requestMessages = requestMessages;
  salvage.accumulated = [];
  loopState.streamError = undefined;
  loopState.streamFinished = false;
  loopState.finishReason = undefined;
  loopState.contextCompactedInEpoch = false;

  const agent = new ToolLoopAgent({
    id: 'haze-main',
    model: setup.runtime.model,
    instructions: systemPrompt,
    tools: sliceTools,
    ...(!omitMaxOutputTokens ? {maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS} : {}),
    ...providerSettings,
    // One provider request + its tool batch per SDK object graph. A normal
    // ToolLoopAgent would make the same next provider request internally.
    stopWhen: isStepCount(1),
    runtimeContext: toolExecutionContext,
    toolsContext: toolsContextFor(sliceTools, toolExecutionContext) as never,
    experimental_repairToolCall: createRepairToolCall(deps),
    prepareStep(args) {
      const prepared = prepare(args);
      // Preserve the exact provider-facing prefix across epochs, including a
      // scoped control injected for this request. Session state strips those
      // controls independently when the epoch commits.
      const preparedMessages = (prepared?.messages as ModelMessage[] | undefined) ?? args.messages;
      salvage.requestMessages = preparedMessages;
      if (completedBefore > 0) {
        const messagesPreserved = requestMessages.length <= preparedMessages.length
          && requestMessages.every((message, index) => preparedMessages[index] === message);
        const requestPolicyStable = prepared?.activeTools == null
          && prepared?.toolChoice == null
          && prepared?.model == null
          && prepared?.providerOptions == null;
        const prefixPreserved = messagesPreserved && requestPolicyStable;
        callbacks.onEvent?.(agentEvent({
          type: 'resource_rollover',
          attempt: retryAttempt + 1,
          completedSteps: completedBefore,
          toolCalls: loopState.generatedToolCalls,
          prefixPreserved,
          reason: prefixPreserved ? 'sdk-step-boundary' : loopState.contextCompactedInEpoch ? 'context-compaction' : 'request-policy-change',
        }));
        callbacks.debugLog(`ToolLoopAgent epoch rollover after step ${completedBefore}; provider prefix ${prefixPreserved ? 'preserved' : 'reset'}`);
      }
      return prepared;
    },
    onStepStart({stepNumber}) {
      callbacks.onEvent?.(agentEvent({type: 'step_start', attempt: retryAttempt + 1, step: loopState.completedSteps + stepNumber + 1}));
    },
    onStepEnd({text, content = [], toolCalls, toolResults, finishReason, usage, response}) {
      // Tool-loop control must advance from this internally ordered callback.
      loopState.toolResultState = applyStepToolResultState(loopState.toolResultState, content);
      recordCompletedStep(loopState, {text, toolCalls});
      // Turn-wide counters remain shared across bounded SDK epochs, retries,
      // and recovery slices. Executions are authoritative for tool-call usage.
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
      callbacks.onEvent?.(agentEvent({type: 'step_end', attempt: retryAttempt + 1, step: loopState.completedSteps, finishReason, toolCallCount: toolCalls.length, usage: publicUsage, ...(response?.modelId ? {responseModel: response.modelId} : {})}));
      logEntry(callbacks.log, {at: new Date().toISOString(), type: 'step', stream: 'main', step: loopState.completedSteps - 1, text, finishReason, usage: {inputTokens: stepUsage.inputTokens, outputTokens: usage?.outputTokens, cacheReadTokens: stepUsage.cacheReadTokens || undefined, cacheWriteTokens: stepUsage.cacheWriteTokens || undefined, noCacheTokens: stepUsage.noCacheTokens || undefined, reasoningTokens: stepUsage.reasoningTokens || undefined, cacheHitRatio: stepUsage.cacheHitRatio}});
      callbacks.debugLog(`step ${loopState.completedSteps - 1} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
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
      const accumulated = [...salvage.requestMessages, ...event.responseMessages];
      callbacks.setConversation(stripSyntheticControls(accumulated));
      callbacks.debugLog(`conversation updated to ${accumulated.length} exact messages by ToolLoopAgent epoch`);
    },
  });

  stallGuard.rearm();
  const result = await agent.stream({messages: requestMessages, abortSignal: abortController.signal});
  for await (const part of result.stream) {
    stallGuard.noteStreamEvent(part.type);
    applyStreamPart(deps, part);
  }
  const providerMessages = await commitStreamResult(deps, result);
  return {providerMessages, completedSteps: loopState.completedSteps - completedBefore};
}

/**
 * Drive one attempt through bounded ToolLoopAgent epochs. The provider prefix,
 * tools, budgets, evidence, and deadline stay continuous; only the AI SDK's
 * request-local retained graph is released at each completed step.
 */
export async function runAttemptStream(deps: AttemptStreamDeps): Promise<AttemptStreamOutcome> {
  const {setup, callbacks, loopState, stallGuard, abortController} = deps;
  let providerMessages = setup.requestMessages;
  const attemptStartStep = loopState.completedSteps;

  while (!abortController.signal.aborted) {
    const epoch = await runAgentEpoch(deps, providerMessages);
    providerMessages = epoch.providerMessages;
    const attemptSteps = loopState.completedSteps - attemptStartStep;
    const continueAfterTools = loopState.finishReason === 'tool-calls'
      && epoch.completedSteps > 0
      && attemptSteps < setup.stepCap;
    if (!continueAfterTools) break;
  }

  if (loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted) {
    finalizeAssistantSegment(loopState, callbacks);
  } else if (loopState.sawToolCall && loopState.assistantText.trim().length === 0) {
    callbacks.addMessage({role: 'system', text: 'Tool work ended without a substantive final answer.'});
  }
  stallGuard.clear();

  return {
    finishReason: loopState.finishReason,
    lastToolOk: loopState.lastToolOk,
    assistantText: loopState.assistantText,
    sawToolCall: loopState.sawToolCall,
    unresolvedMalformedToolName: loopState.unresolvedMalformedToolName,
    unresolvedToolInputError: loopState.unresolvedMalformedToolName != null,
  };
}
