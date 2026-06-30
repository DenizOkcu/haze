import {ToolLoopAgent, stepCountIs, type ModelMessage} from 'ai';
import type {LlmLog} from '../../core/log/llmLog.js';
import {appendLogEntry as logAppend, type LlmLogEntry} from '../../core/log/llmLog.js';
import {modelWithConfig, providerRequestSettings} from '../../llm/client.js';
import {assembleRequestContext} from '../../llm/requestContext.js';
import {projectContextSection, type PromptSession} from '../../llm/systemPrompt.js';
import {closeMcpClients, type LoadedMcpTools} from '../../llm/mcp.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {toolCallSummary, toolResultSummary, formatSeconds} from './formatters.js';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../core/agent/errors.js';
import {isPlanOnlyRequest} from '../../core/goal/requestClassifier.js';
import {repeatedToolCallPrompt, toolLoopBudgetPrompt} from '../../core/goal/completionPolicy.js';
import {estimateValueTokens} from '../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl} from '../../core/agent/requestAssembly.js';
import {isDuplicateSkippedOutput, toolInputField, toolOutputOk} from '../../core/agent/toolResults.js';
import {uniqueRepeatedToolNames, toolOnlyStepCount} from '../../core/agent/turnPolicy.js';
export {uniqueRepeatedToolNames, toolOnlyStepCount} from '../../core/agent/turnPolicy.js';
import {compactModelMessages} from '../../core/agent/compaction.js';
import {ACTIVE_CONTEXT_TOKEN_BUDGET, DEFAULT_MAX_OUTPUT_TOKENS, IDLE_TIMEOUT_MS, MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, MAIN_TOOL_ONLY_STEP_LIMIT} from '../../core/agent/budgets.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent} from '../../core/goal/sessionGoal.js';
import type {WorkState} from '../../core/agent/workState.js';
import {sanitizeAssistantText, assistantDisplayText, normalizeAssistantText, shouldStartAssistantStream, isHiddenAssistantFragment, isHiddenUnstartedFinalText, isShortLeadInBeforeTool, isShortUnfinishedLeadIn} from './streaming/assistantText.js';
import {createToolGroupRenderer, type NativeToolCall} from './streaming/toolGroupRenderer.js';
import {applyToolResultState, initialToolResultState, isMutatingToolName} from './streaming/toolResultState.js';
import {abortableDelay, estimateInputBreakdown, extractUsage, rememberContextFilesFromToolOutput, responseCompletionMetrics, retryDelayMs, stepCacheMetrics, subagentTokenEstimate, type TokenUsage} from './streaming/turnRuntime.js';
import type {HazeToolContext} from '../../llm/tools/toolContext.js';
export type {TokenUsage} from './streaming/turnRuntime.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number};

export type TurnStatus = 'complete' | 'aborted' | 'failed';

/** Authoritative outcome of a turn, so callers (esp. headless/CI) need not sniff message text. */
export interface TurnResult {
  status: TurnStatus;
}

type NativeToolFinish = {toolCall: NativeToolCall; success: boolean; output?: unknown; error?: unknown; durationMs: number};

function logEntry(log: LlmLog | undefined, entry: LlmLogEntry) {
  if (log) void logAppend(log, entry).catch(() => undefined);
}

function withScopedContextSystem(messages: ModelMessage[], context: HazeToolContext): ModelMessage[] {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return [
    ...messages,
    {role: 'system', content: `Additional scoped project instructions were just read for a non-root path touched by a tool call. Apply them to subsequent work in that subtree.${projectContextSection(files)}`},
  ];
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
): Promise<TurnResult> {
  const displayVal = displayValue ?? value;
  callbacks.onEvent?.(agentEvent({type: 'turn_start', request: value}));
  callbacks.setBusy(true);
  callbacks.setBusyLabel?.('Haze is thinking');
  if (!retryingExistingRequest) callbacks.addMessage({role: 'user', text: displayVal});
  const abortController = new AbortController();
  callbacks.setAbortController?.(abortController);

  let turnStatus: 'complete' | 'aborted' | 'failed' = 'failed';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let loadedMcp: LoadedMcpTools | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortController.abort('Haze turn timed out after no model/tool activity.');
    }, IDLE_TIMEOUT_MS);
  };

  const toolDisplay = createToolGroupRenderer({addMessage: callbacks.addMessage, updateMessage: callbacks.updateMessage, debugLog: callbacks.debugLog, onEvent: callbacks.onEvent, log: callbacks.log});

  try {
    const runtime = await modelWithConfig({cwd: session?.cwd, modelSelector: modelOverride});
    if (!runtime?.model) {
      callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. Haze cannot hallucinate without a model. Progress.'});
      turnStatus = 'complete';
      return {status: turnStatus};
    }

    let activeContextFiles = contextFiles;
    const activeModel = runtime.model;
    const providerSettings = providerRequestSettings(runtime.config);
    const assembled = await assembleRequestContext({contextFiles: activeContextFiles, session, model: activeModel});
    const availableTools = assembled.availableTools;
    loadedMcp = assembled.loadedMcp;
    if (loadedMcp?.errors.length) callbacks.addMessage({role: 'system', text: `MCP: ${loadedMcp.errors.join('; ')}`});

    const goal = createSessionGoal(value);
    callbacks.setWorkState?.(goal);
    callbacks.setGoalStatus?.(formatGoalStatus(goal));
    const likelyPlanOnlyRequest = isPlanOnlyRequest(value);

    const durableRequestMessages = compactToolHistory(
      retryingExistingRequest
        ? stripSyntheticControls(callbacks.getConversation())
        : [...stripSyntheticControls(callbacks.getConversation()), {role: 'user', content: value}],
    ).messages;
    let requestMessages = durableRequestMessages;
    if (estimateValueTokens(requestMessages) > ACTIVE_CONTEXT_TOKEN_BUDGET) {
      requestMessages = compactModelMessages(requestMessages, {tokenBudget: ACTIVE_CONTEXT_TOKEN_BUDGET, workState: goal}).messages;
    }
    callbacks.setConversation(stripSyntheticControls(requestMessages));

    const systemPrompt = assembled.systemPrompt;
    const inputBreakdown = estimateInputBreakdown({system: systemPrompt, contextFiles: activeContextFiles, messages: requestMessages, tools: availableTools});
    logEntry(callbacks.log, {at: new Date().toISOString(), type: 'request', stream: 'main', system: systemPrompt, messages: requestMessages, tools: Object.keys(availableTools), context: inputBreakdown.breakdown});

    const previousAssistantText = normalizeAssistantText(callbacks.getLastAssistantText());
    const visibleAssistantTexts = new Set(previousAssistantText ? [previousAssistantText] : []);
    const rememberVisibleAssistantText = (text: string) => {
      const normalized = normalizeAssistantText(text);
      if (!normalized) return;
      visibleAssistantTexts.add(normalized);
      callbacks.setLastAssistantText(text);
    };

    const contextFileSignatures = callbacks.contextFileSignatures ?? new Map(activeContextFiles.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));
    const toolExecutionContext: HazeToolContext = {inFlightToolCalls: new Map<string, Promise<unknown>>(), loadedContextFilePaths: new Set(activeContextFiles.map(file => file.path)), loadedContextFileSignatures: contextFileSignatures, onContextFileRead: path => toolDisplay.addContextFileRead(path)};
    const startedTools = new Map<string, number>();
    const latestToolCalls = new Map<string, NativeToolCall>();
    let latestAccumulatedResponseMessages: ModelMessage[] = [];
    let currentAssistantId = `assistant-${Date.now()}`;
    let assistantStarted = false;
    let assistantStartedAt = Date.now();
    let assistantText = '';
    let currentAssistantText = '';
    let streamError: unknown;
    let streamFinished = false;
    let toolResultState = initialToolResultState();
    const resetAssistantSegment = () => {
      currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      assistantStarted = false;
      assistantStartedAt = Date.now();
      currentAssistantText = '';
    };
    const finalizeAssistantSegment = (options: {beforeTool?: boolean} = {}) => {
      const finalText = assistantDisplayText(currentAssistantText);
      const normalized = normalizeAssistantText(finalText);
      const hidden = (assistantStarted ? isHiddenAssistantFragment(finalText) : isHiddenUnstartedFinalText(finalText))
        || (options.beforeTool === true && isShortLeadInBeforeTool(finalText))
        || (options.beforeTool !== true && isShortUnfinishedLeadIn(finalText))
        || (normalized.length > 0 && visibleAssistantTexts.has(normalized));
      if (assistantStarted) {
        if (!hidden) rememberVisibleAssistantText(finalText);
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: finalText, hidden}));
        callbacks.updateMessage(currentAssistantId, {text: finalText, streaming: false, hidden, ...responseCompletionMetrics(finalText, assistantStartedAt)});
      } else if (!hidden) {
        if (!hidden) rememberVisibleAssistantText(finalText);
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: finalText, hidden: false}));
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: finalText, streaming: false, startedAt: assistantStartedAt, ...responseCompletionMetrics(finalText, assistantStartedAt)});
      }
      resetAssistantSegment();
      return !hidden;
    };

    const agent = new ToolLoopAgent({
      id: 'haze-main',
      model: activeModel,
      instructions: systemPrompt,
      tools: availableTools,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      ...providerSettings,
      stopWhen: stepCountIs(MAIN_STEP_LIMIT),
      experimental_context: toolExecutionContext,
      prepareStep({steps, messages}) {
        const toolCalls = steps.flatMap(step => step.toolCalls);
        const repeatedToolNames = uniqueRepeatedToolNames(toolCalls);
        const scopedMessages = withScopedContextSystem(messages, toolExecutionContext);
        const messagesChanged = scopedMessages !== messages;
        if (likelyPlanOnlyRequest && toolResultState.mutatingToolSucceeded) return messagesChanged ? {toolChoice: 'none' as const, messages: scopedMessages} : {toolChoice: 'none' as const};
        if (toolResultState.editRecoveryPath && !toolResultState.editRecoveryReadSatisfied) return messagesChanged ? {activeTools: ['readFile'] as Array<keyof typeof availableTools>, messages: scopedMessages} : {activeTools: ['readFile'] as Array<keyof typeof availableTools>};
        if (repeatedToolNames.length > 0) {
          const activeTools = (Object.keys(availableTools) as Array<keyof typeof availableTools>).filter(name => !repeatedToolNames.includes(name as string));
          callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
          return activeTools.length > 0
            ? {activeTools, messages: withSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))}
            : {toolChoice: 'none', messages: withSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))};
        }
        if (toolCalls.length >= MAIN_TOOL_CALL_LIMIT || toolOnlyStepCount(steps) >= MAIN_TOOL_ONLY_STEP_LIMIT) {
          callbacks.debugLog('forcing text response to avoid tool loop');
          return {toolChoice: 'none', messages: withSyntheticControl(scopedMessages, toolLoopBudgetPrompt())};
        }
        return messagesChanged ? {messages: scopedMessages} : undefined;
      },
      onStepFinish({stepNumber, text, toolCalls, toolResults, finishReason, usage, response}) {
        if (Array.isArray(response?.messages) && response.messages.length > 0) latestAccumulatedResponseMessages = response.messages as ModelMessage[];
        const stepUsage = stepCacheMetrics(usage);
        logEntry(callbacks.log, {at: new Date().toISOString(), type: 'step', stream: 'main', step: stepNumber, text, finishReason, usage: {inputTokens: stepUsage.inputTokens, outputTokens: usage?.outputTokens, cacheReadTokens: stepUsage.cacheReadTokens || undefined, cacheWriteTokens: stepUsage.cacheWriteTokens || undefined, noCacheTokens: stepUsage.noCacheTokens || undefined, reasoningTokens: stepUsage.reasoningTokens || undefined, cacheHitRatio: stepUsage.cacheHitRatio}});
        callbacks.debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
      },
      onFinish(event) {
        const providerUsage = extractUsage({usage: event.totalUsage ?? event.usage});
        callbacks.recordTokenUsage?.({
          inputTokens: providerUsage.inputTokens,
          outputTokens: providerUsage.outputTokens,
          systemPrompt: inputBreakdown.systemPrompt,
          messages: inputBreakdown.messages,
          toolSchemas: inputBreakdown.toolSchemas,
          outputEstimate: estimateValueTokens(event.response.messages),
          cacheReadTokens: providerUsage.cacheReadTokens,
          cacheWriteTokens: providerUsage.cacheWriteTokens,
          noCacheTokens: providerUsage.noCacheTokens,
          reasoningTokens: providerUsage.reasoningTokens,
          logicalInputEstimate: inputBreakdown.logicalInputEstimate,
          effectiveNonCachedInput: providerUsage.effectiveNonCachedInput,
        });
        const accumulated = [...stripSyntheticControls(requestMessages), ...event.response.messages];
        const compacted = compactToolHistory(accumulated);
        callbacks.setConversation(compacted.messages);
        callbacks.debugLog(`conversation updated to ${compacted.messages.length} messages by ToolLoopAgent`);
      },
    });

    resetIdleTimer();
    const result = await agent.stream({messages: requestMessages, abortSignal: abortController.signal});

    for await (const part of result.fullStream) {
      resetIdleTimer();
      switch (part.type) {
        case 'text-delta': {
          toolDisplay.startFreshToolGroup();
          const delta = sanitizeAssistantText(part.text);
          assistantText += delta;
          currentAssistantText += delta;
          const displayText = assistantDisplayText(currentAssistantText);
          if (!assistantStarted && !shouldStartAssistantStream(displayText, assistantStartedAt)) break;
          if (!assistantStarted) {
            assistantStarted = true;
            assistantStartedAt = Date.now();
            callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
            callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: displayText, streaming: true, startedAt: assistantStartedAt});
          } else {
            callbacks.onEvent?.(agentEvent({type: 'message_update', id: currentAssistantId, text: displayText}));
            callbacks.updateMessage(currentAssistantId, {text: displayText});
          }
          break;
        }
        case 'tool-input-start': {
          if (currentAssistantText.trim().length > 0 || assistantStarted) {
            const pending = assistantDisplayText(currentAssistantText);
            const shown = finalizeAssistantSegment({beforeTool: true});
            if (!shown && pending) toolDisplay.setGroupCaption(pending);
          }
          const toolCall = {toolCallId: part.id, toolName: part.toolName, input: {}};
          latestToolCalls.set(part.id, toolCall);
          startedTools.set(part.id, Date.now());
          toolDisplay.ensureToolItem(toolCall);
          break;
        }
        case 'tool-call': {
          if (currentAssistantText.trim().length > 0 || assistantStarted) {
            const pending = assistantDisplayText(currentAssistantText);
            const shown = finalizeAssistantSegment({beforeTool: true});
            if (!shown && pending) toolDisplay.setGroupCaption(pending);
          }
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          if (!startedTools.has(part.toolCallId)) startedTools.set(part.toolCallId, Date.now());
          toolDisplay.ensureToolItem(toolCall).summary = toolCallSummary(part.toolName, part.input);
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'tool-result': {
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          const finish: NativeToolFinish = {toolCall, success: true, output: part.output, durationMs: Date.now() - startedAt};
          const item = toolDisplay.ensureToolItem(toolCall);
          item.status = toolOutputOk(part.output, true) ? 'success' : 'error';
          item.result = toolResultSummary(finish);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: true, output: part.output, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: true, output: part.output, durationMs: finish.durationMs}});
          const ok = toolOutputOk(part.output, true);
          toolResultState = applyToolResultState(toolResultState, {toolName: toolCall.toolName, input: toolCall.input, output: part.output, ok});
          observeGoalToolEvent(goal, {...toolCall, success: ok, output: part.output, duplicateSkipped: isDuplicateSkippedOutput(part.output)});
          callbacks.setWorkState?.(goal);
          callbacks.setGoalStatus?.(formatGoalStatus(goal));
          activeContextFiles = rememberContextFilesFromToolOutput(activeContextFiles, part.output);
          if (toolCall.toolName === 'writeTasks') callbacks.onTasksChanged?.();
          const nestedTokens = subagentTokenEstimate(part.output);
          if (nestedTokens) callbacks.recordTokenUsage?.({inputTokens: nestedTokens.input, outputTokens: nestedTokens.output, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: nestedTokens.input, reasoningTokens: 0, logicalInputEstimate: nestedTokens.input, effectiveNonCachedInput: nestedTokens.input});
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'tool-error': {
          const existing = latestToolCalls.get(part.toolCallId);
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input ?? existing?.input};
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          const finish: NativeToolFinish = {toolCall, success: false, error: part.error, durationMs: Date.now() - startedAt};
          const item = toolDisplay.ensureToolItem(toolCall);
          item.status = 'error';
          item.result = toolResultSummary(finish);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, error: part.error, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: false, error: part.error, durationMs: finish.durationMs}});
          if (isMutatingToolName(toolCall.toolName)) {
            toolResultState = {...toolResultState, editRecoveryPath: toolInputField(toolCall.input, 'path'), editRecoveryReadSatisfied: false};
          }
          observeGoalToolEvent(goal, {...toolCall, success: false, output: part.error});
          callbacks.setWorkState?.(goal);
          callbacks.setGoalStatus?.(formatGoalStatus(goal));
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'error':
          streamError = part.error;
          callbacks.debugLog(`stream error: ${part.error instanceof Error ? part.error.message : String(part.error)}`);
          break;
        case 'finish':
          streamFinished = true;
          callbacks.debugLog(`ToolLoopAgent finished: ${part.finishReason}`);
          break;
        case 'reasoning-start':
        case 'reasoning-delta':
        case 'reasoning-end':
          // Anthropic extended thinking emits reasoning events. They are not user-facing
          // assistant text and are intentionally discarded from the render stream.
          break;
        default:
          break;
      }
    }

    try {
      const response = await result.response;
      const completedConversation = [...stripSyntheticControls(requestMessages), ...response.messages];
      callbacks.setConversation(compactToolHistory(completedConversation).messages);
    } catch (error) {
      if (latestAccumulatedResponseMessages.length > 0) {
        callbacks.setConversation(compactToolHistory([...stripSyntheticControls(requestMessages), ...latestAccumulatedResponseMessages]).messages);
      }
      const text = error instanceof Error ? error.message : String(error);
      const benignTerminatedAfterStream = text === 'terminated' && (streamFinished || assistantText.trim().length > 0 || latestToolCalls.size > 0);
      if (!benignTerminatedAfterStream) throw streamError ?? error;
      callbacks.debugLog(`ignored post-stream response error: ${text}`);
    }

    if (currentAssistantText.trim().length > 0 || assistantStarted) {
      finalizeAssistantSegment();
    } else if (latestToolCalls.size > 0) {
      const fallback = 'Finished tool work.';
      callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: fallback, streaming: false, startedAt: assistantStartedAt, ...responseCompletionMetrics(fallback, assistantStartedAt)});
    }

    goal.phase = 'done';
    goal.status = 'complete';
    callbacks.setGoalStatus?.(undefined);
    turnStatus = 'complete';
  } catch (error) {
    if (abortController.signal.aborted) {
      turnStatus = 'aborted';
      callbacks.debugLog('request aborted');
      callbacks.addMessage({role: 'system', text: 'Thinking aborted. You can type again.'});
    } else {
      const text = error instanceof Error ? error.message : String(error);
      callbacks.debugLog(`error: ${text}`);
      if (!contextOverflowRecovered && isContextOverflowError(error)) {
        const compacted = callbacks.compactConversation?.('Automatic recovery after provider context overflow. Preserve the active user request and concrete next steps.') ?? false;
        callbacks.onEvent?.(agentEvent({type: 'context_overflow', recovered: compacted, error: text}));
        if (compacted) {
          callbacks.addMessage({role: 'system', text: 'Context overflow detected; compacted older context and retrying the same request once.'});
          return await runAgentTurn(value, displayValue, contextFiles, callbacks, retryAttempt, true, true, session, modelOverride);
        }
        callbacks.addMessage({role: 'system', text: 'Context overflow detected, but there was not enough conversation history to compact automatically.'});
      }
      const maxRetries = 2;
      if (retryAttempt < maxRetries && isRetryableModelError(error)) {
        const delay = retryDelayMs(retryAttempt);
        callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: maxRetries, delayMs: delay, error: text}));
        callbacks.addMessage({role: 'system', text: `Transient model error; retrying attempt ${retryAttempt + 1}/${maxRetries} in ${formatSeconds(delay)}: ${text}`});
        await abortableDelay(delay, abortController.signal);
        if (abortController.signal.aborted) {
          turnStatus = 'aborted';
          return {status: turnStatus};
        }
        return await runAgentTurn(value, displayValue, contextFiles, callbacks, retryAttempt + 1, true, contextOverflowRecovered, session, modelOverride);
      }
      callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
    }
  } finally {
    if (loadedMcp?.clients.length) await closeMcpClients(loadedMcp.clients);
    if (idleTimer) clearTimeout(idleTimer);
    toolDisplay.stopToolTimer();
    toolDisplay.finalizeToolGroup();
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status: turnStatus}));
    callbacks.setAbortController?.(null);
    callbacks.setBusyLabel?.('Haze is thinking');
    callbacks.setBusy(false);
  }
  return {status: turnStatus};
}
