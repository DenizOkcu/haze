import {createHash} from 'node:crypto';
import {ToolLoopAgent, generateText, isStepCount, type ModelMessage} from 'ai';
import {agentEvent} from '../../../core/agent/events.js';
import {type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {contextTokensFromUsage, estimateConversationTokens, estimateValueTokens, type ContextUsageAnchor} from '../../../core/agent/contextBudget.js';
import {stripSyntheticControls} from '../../../core/agent/requestAssembly.js';
import {buildLlmCompactionPrompt, chooseBoundaryCompactionMethod, compactModelMessages, compactModelMessagesWithSummary, extractExistingCompactionSummary} from '../../../core/agent/compaction.js';
import {isLengthStopOverflow, isSilentContextOverflow} from '../../../core/agent/overflow.js';
import {type TurnExecutionState} from '../../../core/agent/completionController.js';
import {COMPACTION_LLM_MAX_OUTPUT_TOKENS, COMPACTION_LLM_MIN_OLDER_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, type ToolExecutionBudgetState, type TurnBudget} from '../../../core/agent/budgets.js';
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
  /** Last valid per-step provider usage (input/output/cache), for usage-overflow detection (Pillar 1.2). */
  lastUsage: {inputTokens: number | undefined; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number} | undefined;
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
    lastUsage: undefined,
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
  /**
   * Non-error context overflow detected from usage (Pillar 1.2): `silent`
   * (usage exceeded the window on a successful finish) or `length-stop`
   * (truncated input filled the window leaving no output room). Routed to
   * compact-and-retry recovery in `finalizeAttemptOutcome`.
   */
  usageOverflow: 'silent' | 'length-stop' | undefined;
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
  /** Turn-scoped usage anchor for provider-usage-backed context estimation (Pillar 1.1). */
  usageAnchor: {current: ContextUsageAnchor | undefined};
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
  // Epoch-final provider usage for the usage anchor (Pillar 1.1); onEnd fires
  // before the stream promise settles, so stash and commit after commitStreamResult.
  let epochUsage: {inputTokens?: number; outputTokens?: number; cacheReadTokens: number; cacheWriteTokens: number} | undefined;

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
      // Remember the last valid per-step usage for usage-overflow detection
      // (Pillar 1.2); empty usage objects (some gateways/tests) keep the
      // previous value or stay unset.
      const stepUsage = stepCacheMetrics(usage);
      if (stepUsage.inputTokens != null || usage?.outputTokens != null || stepUsage.cacheReadTokens > 0 || stepUsage.cacheWriteTokens > 0) {
        loopState.lastUsage = {inputTokens: stepUsage.inputTokens, outputTokens: usage?.outputTokens ?? 0, cacheReadTokens: stepUsage.cacheReadTokens, cacheWriteTokens: stepUsage.cacheWriteTokens};
      }
      // Turn-wide counters remain shared across bounded SDK epochs, retries,
      // and recovery slices. Executions are authoritative for tool-call usage.
      turnState.stepsUsed += 1;
      turnState.toolCallsUsed = globalBudget.started;
      if (toolCalls.length > 0 && text.trim().length === 0) turnState.toolOnlyStepsUsed += 1;
      if (Array.isArray(response?.messages) && response.messages.length > 0) salvage.accumulated = response.messages as ModelMessage[];
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
      epochUsage = {inputTokens: providerUsage.inputTokens, outputTokens: providerUsage.outputTokens, cacheReadTokens: providerUsage.cacheReadTokens, cacheWriteTokens: providerUsage.cacheWriteTokens};
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
  // Re-anchor context estimation on the provider's own accounting for the
  // committed history (Pillar 1.1). The anchor indexes the control-free
  // message sequence so it stays aligned with durable conversation state.
  const anchorTokens = contextTokensFromUsage(epochUsage ?? {});
  if (anchorTokens != null) deps.usageAnchor.current = {messageCount: stripSyntheticControls(providerMessages).length, contextTokens: anchorTokens};
  return {providerMessages, completedSteps: loopState.completedSteps - completedBefore};
}

/**
 * Mid-turn compaction at an epoch boundary (Pillar 1.5/1.6): before the next
 * provider request, shrink the history when the (usage-anchored) estimate
 * exceeds the message budget — the anchored total drives the decision, so
 * token-dense history the chars/4 estimate undercounts still compacts. Large
 * older halves get an LLM-written summary —
 * chained from any previous compaction summary and split-turn aware — while
 * small trims keep the deterministic heuristic excerpt. Any summarization
 * failure falls back to the heuristic excerpt. Rewrites the provider prefix
 * exactly once and invalidates the usage anchor (the next step re-anchors on
 * fresh provider usage).
 */
async function compactAtEpochBoundary(deps: AttemptStreamDeps, providerMessages: ModelMessage[]): Promise<ModelMessage[]> {
  const {setup, callbacks, loopState, goal, abortController, usageAnchor} = deps;
  const overhead = setup.requestBudget.systemTokens + setup.requestBudget.toolSchemaTokens;
  const estimate = estimateConversationTokens(providerMessages, usageAnchor.current, overhead);
  const decision = chooseBoundaryCompactionMethod({messages: providerMessages, messageTokenBudget: setup.requestBudget.messageTokens, olderTokenThreshold: COMPACTION_LLM_MIN_OLDER_TOKENS, totalTokens: estimate.tokens});
  if (decision.method === 'none' || !decision.split) return providerMessages;
  const split = decision.split;
  const tokenBudget = setup.requestBudget.messageTokens;
  if (decision.method === 'heuristic') {
    callbacks.onEvent?.(agentEvent({type: 'compaction_start', reason: 'threshold', method: 'heuristic'}));
    const result = compactModelMessages(providerMessages, {tokenBudget, workState: goal});
    if (!result.compacted) {
      // Nothing older qualified; close the opened event truthfully.
      callbacks.onEvent?.(agentEvent({type: 'compaction_end', reason: 'threshold', method: 'none', compacted: false}));
      return providerMessages;
    }
    callbacks.onEvent?.(agentEvent({type: 'compaction_end', reason: 'threshold', method: 'heuristic', compacted: true, olderCount: result.olderCount, keptCount: result.keptCount}));
    callbacks.debugLog(`mid-turn compaction (heuristic): condensed ${result.olderCount} messages (${estimate.basis}-backed estimate ${estimate.tokens} > budget ${tokenBudget})`);
    loopState.contextCompactedInEpoch = true;
    usageAnchor.current = undefined;
    callbacks.recordCompaction?.({method: 'heuristic', olderCount: result.olderCount, keptCount: result.keptCount, summary: result.summary ?? ''});
    callbacks.setConversation(result.messages);
    return result.messages;
  }
  callbacks.onEvent?.(agentEvent({type: 'compaction_start', reason: 'threshold', method: 'llm'}));
  try {
    const prompt = buildLlmCompactionPrompt({
      older: split.older,
      previousSummary: extractExistingCompactionSummary(providerMessages),
      splitTurn: split.splitTurn,
    });
    const summarization = await generateText({
      model: setup.runtime.model,
      prompt,
      maxOutputTokens: COMPACTION_LLM_MAX_OUTPUT_TOKENS,
      abortSignal: abortController.signal,
    });
    const summaryText = summarization.text.trim();
    if (!summaryText) throw new Error('model returned an empty summary');
    const result = compactModelMessagesWithSummary(providerMessages, {summaryText, tokenBudget, workState: goal});
    if (!result.compacted) throw new Error('nothing older to compact');
    callbacks.onEvent?.(agentEvent({type: 'compaction_end', reason: 'threshold', method: 'llm', compacted: true, olderCount: result.olderCount, keptCount: result.keptCount}));
    callbacks.recordTokenUsage?.({
      inputTokens: summarization.usage?.inputTokens,
      outputTokens: summarization.usage?.outputTokens,
      systemPrompt: 0,
      messages: 0,
      toolSchemas: 0,
      outputEstimate: 0,
      cacheReadTokens: summarization.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: summarization.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      noCacheTokens: 0,
      reasoningTokens: summarization.usage?.outputTokenDetails?.reasoningTokens ?? 0,
      logicalInputEstimate: 0,
      effectiveNonCachedInput: undefined,
    });
    callbacks.debugLog(`mid-turn compaction (llm summary${split.splitTurn ? ', split turn' : ''}${extractExistingCompactionSummary(providerMessages) ? ', chained' : ''}): condensed ${result.olderCount} messages (${estimate.basis}-backed estimate ${estimate.tokens} > budget ${tokenBudget})`);
    loopState.contextCompactedInEpoch = true;
    usageAnchor.current = undefined;
    callbacks.recordCompaction?.({method: 'llm', olderCount: result.olderCount, keptCount: result.keptCount, summary: result.summary ?? ''});
    callbacks.setConversation(result.messages);
    return result.messages;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbacks.debugLog(`mid-turn LLM compaction failed (${message}); falling back to the heuristic excerpt`);
    const fallback = compactModelMessages(providerMessages, {tokenBudget, workState: goal});
    // One truthful end event: the heuristic excerpt's actual outcome, with the
    // LLM failure attached for diagnosis.
    callbacks.onEvent?.(agentEvent({type: 'compaction_end', reason: 'threshold', method: fallback.compacted ? 'heuristic' : 'none', compacted: fallback.compacted, olderCount: fallback.olderCount, keptCount: fallback.keptCount, error: `llm summary failed: ${message}`}));
    if (!fallback.compacted) return providerMessages;
    loopState.contextCompactedInEpoch = true;
    usageAnchor.current = undefined;
    callbacks.recordCompaction?.({method: 'heuristic', olderCount: fallback.olderCount, keptCount: fallback.keptCount, summary: fallback.summary ?? ''});
    callbacks.setConversation(fallback.messages);
    return fallback.messages;
  }
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
    // Budget-aware mid-turn compaction before the next provider request
    // (Pillar 1.5); a no-op while the conversation fits.
    providerMessages = await compactAtEpochBoundary(deps, providerMessages);
  }

  if (loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted) {
    finalizeAssistantSegment(loopState, callbacks);
  } else if (loopState.sawToolCall && loopState.assistantText.trim().length === 0) {
    callbacks.addMessage({role: 'system', text: 'Tool work ended without a substantive final answer.'});
  }
  stallGuard.clear();

  // Non-error overflow detection from the last valid usage (Pillar 1.2):
  // silent overflow (successful finish, usage over the window) and
  // length-stop overflow (length finish, zero output, input filling the
  // window). Both route to compact-and-retry in the attempt outcome.
  const window = setup.runtime.config.contextWindowTokens;
  const usage = loopState.lastUsage;
  let usageOverflow: 'silent' | 'length-stop' | undefined;
  if (usage && loopState.finishReason === 'stop' && isSilentContextOverflow({inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, contextWindowTokens: window})) {
    usageOverflow = 'silent';
  } else if (usage && isLengthStopOverflow({finishReason: loopState.finishReason, outputTokens: usage.outputTokens, inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, contextWindowTokens: window})) {
    usageOverflow = 'length-stop';
  }
  if (usageOverflow) callbacks.debugLog(`detected ${usageOverflow} context overflow from provider usage (window ${window})`);

  return {
    finishReason: loopState.finishReason,
    lastToolOk: loopState.lastToolOk,
    assistantText: loopState.assistantText,
    sawToolCall: loopState.sawToolCall,
    unresolvedMalformedToolName: loopState.unresolvedMalformedToolName,
    unresolvedToolInputError: loopState.unresolvedMalformedToolName != null,
    usageOverflow,
  };
}
