import {ToolLoopAgent, isStepCount, type ModelMessage} from 'ai';
import type {LlmLog} from '../../core/log/llmLog.js';
import {appendLogEntry as logAppend, type LlmLogEntry} from '../../core/log/llmLog.js';
import {modelWithConfig, providerRequestSettings} from '../../llm/client.js';
import {assembleRequestContext, type SubagentOverrides, type TurnExecutionScope} from '../../llm/requestContext.js';
import {projectContextSection, type PromptSession} from '../../llm/systemPrompt.js';
import {closeMcpClients, type LoadedMcpTools} from '../../llm/mcp.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {readSettings} from '../../config/settings.js';
import {toolCallSummary, toolResultSummary, busyToolLabel, formatSeconds} from './formatters.js';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../core/agent/errors.js';
import {isPlanOnlyRequest} from '../../core/goal/requestClassifier.js';
import {userTurnMessage, type ImageAttachment} from '../../core/attachments/imageAttachments.js';
import {type BlessedPath} from '../../core/attachments/readBlessings.js';
import {malformedToolCallPrompt, repeatedToolCallPrompt, toolLoopBudgetPrompt} from '../../core/goal/completionPolicy.js';
import {estimateValueTokens} from '../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl, withoutSystemMessages} from '../../core/agent/requestAssembly.js';
import {isDuplicateSkippedOutput, toolInputField, toolOutputOk} from '../../core/agent/toolResults.js';
import {uniqueRepeatedToolNames, toolOnlyStepCount} from '../../core/agent/turnPolicy.js';
export {uniqueRepeatedToolNames, toolOnlyStepCount} from '../../core/agent/turnPolicy.js';
import {compactModelMessages} from '../../core/agent/compaction.js';
import {ACTIVE_CONTEXT_TOKEN_BUDGET, DEFAULT_MAX_OUTPUT_TOKENS, IDLE_TIMEOUT_MS, MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, MAIN_TOOL_ONLY_STEP_LIMIT, WRITE_FILE_CHUNK_BYTES} from '../../core/agent/budgets.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent} from '../../core/goal/sessionGoal.js';
import type {WorkState} from '../../core/agent/workState.js';
import {sanitizeAssistantText, assistantDisplayText, normalizeAssistantText, shouldStartAssistantStream, isHiddenAssistantFragment, isHiddenUnstartedFinalText, isShortLeadInBeforeTool, isShortUnfinishedLeadIn} from './streaming/assistantText.js';
import {createToolGroupRenderer, toolDiffFromResult, type NativeToolCall, type ToolDisplayDiff} from './streaming/toolGroupRenderer.js';
import {applyToolResultState, initialToolResultState, isMutatingToolName} from './streaming/toolResultState.js';
import {abortableDelay, estimateInputBreakdown, extractUsage, rememberContextFilesFromToolOutput, responseCompletionMetrics, retryDelayMs, stepCacheMetrics, subagentTokenEstimate, type TokenUsage} from './streaming/turnRuntime.js';
import {toolsContextFor, type HazeToolContext} from '../../llm/tools/toolContext.js';
import {modelThinkingLabel} from '../../utils/modelName.js';
import {terminalTurnStatus} from './streaming/turnOutcome.js';
import {createIdleTimer} from './streaming/idleTimer.js';
import {isMalformedToolInputError} from './streaming/toolCallRecovery.js';
import {WorkspaceMutationPolicy} from '../../core/subagent/workspaceMutationPolicy.js';
export type {TokenUsage} from './streaming/turnRuntime.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number; toolCount?: number; toolDiffs?: ToolDisplayDiff[]};

export type TurnStatus = 'complete' | 'aborted' | 'failed';

/** Authoritative outcome of a turn, so callers (esp. headless/CI) need not sniff message text. */
export interface TurnResult {
  status: TurnStatus;
}

export interface TurnExecutionOptions {
  ephemeralControl?: string;
  subagentOverrides?: SubagentOverrides;
  /** User-attached images for this turn (F03); only the first attempt carries them. */
  attachments?: readonly ImageAttachment[];
  /** User-mentioned paths whose reads may escape workspace confinement this turn. */
  blessedPaths?: readonly BlessedPath[];
}

type NativeToolFinish = {toolCall: NativeToolCall; success: boolean; output?: unknown; error?: unknown; durationMs: number};

function logEntry(log: LlmLog | undefined, entry: LlmLogEntry) {
  if (log) void logAppend(log, entry).catch(() => undefined);
}

function withScopedContextControl(messages: ModelMessage[], context: HazeToolContext): ModelMessage[] {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return withSyntheticControl(
    messages,
    `Additional scoped project instructions were just read for a non-root path touched by a tool call. Apply them to subsequent work in that subtree.${projectContextSection(files)}`,
  );
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

type AgentAttemptResult = TurnResult & {
  retry?: {attempt: number; contextOverflowRecovered: boolean; delayMs: number};
};

async function runAgentAttempt(
  value: string,
  contextFiles: ContextFile[],
  callbacks: StreamCallbacks,
  retryAttempt: number,
  retryingExistingRequest: boolean,
  contextOverflowRecovered: boolean,
  session: PromptSession | undefined,
  modelOverride: string | undefined,
  abortController: AbortController,
  turnOptions: TurnExecutionOptions,
  turnScope: {executionScope?: TurnExecutionScope},
): Promise<AgentAttemptResult> {
  let thinkingLabel = modelThinkingLabel(undefined);
  callbacks.setBusyLabel?.(thinkingLabel);
  let turnStatus: TurnStatus = 'failed';
  let loadedMcp: LoadedMcpTools | undefined;
  // Tool calls currently executing. A concurrent subagent wave can run for many
  // minutes with no stream parts; that is activity, not a dead stream, so the
  // idle timer defers while any tool is in flight (see streaming/idleTimer.ts).
  const inFlightTools = new Set<string>();
  const idleTimer = createIdleTimer({
    timeoutMs: IDLE_TIMEOUT_MS,
    isBusy: () => inFlightTools.size > 0,
    onTimeout: () => abortController.abort('haze turn timed out after no model/tool activity.'),
  });

  const toolDisplay = createToolGroupRenderer({addMessage: callbacks.addMessage, updateMessage: callbacks.updateMessage, debugLog: callbacks.debugLog, onEvent: callbacks.onEvent, log: callbacks.log});

  try {
    // Single choke point: one fresh settings read per turn, shared by model
    // resolution and request assembly (CR-024).
    const turnSettings = await readSettings();
    const runtime = await modelWithConfig({cwd: session?.cwd, modelSelector: modelOverride}, turnSettings);
    if (!runtime?.model) {
      callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. haze cannot hallucinate without a model. Progress.'});
      turnStatus = 'failed';
      return {status: turnStatus};
    }

    thinkingLabel = modelThinkingLabel(runtime.config.modelName);
    callbacks.setBusyLabel?.(thinkingLabel);

    let activeContextFiles = contextFiles;
    const activeModel = runtime.model;
    const {omitMaxOutputTokens, ...providerSettings} = providerRequestSettings(runtime.config);
    const assembled = await assembleRequestContext({contextFiles: activeContextFiles, session, model: activeModel, modelRuntime: runtime, subagentOverrides: turnOptions.subagentOverrides, abortSignal: abortController.signal, executionScope: turnScope.executionScope, settings: turnSettings, onSubagentEvent: event => callbacks.onEvent?.(agentEvent(event.type === 'queued'
      ? {type: 'subagent_state', id: event.id, state: 'queued', mode: event.mode, queued: event.queued, running: event.running}
      : event.type === 'started'
        ? {type: 'subagent_state', id: event.id, state: 'started', mode: event.mode, queueMs: event.queueMs, running: event.running}
        : event.type === 'terminal'
          ? {type: 'subagent_state', id: event.id, state: 'terminal', mode: event.mode, queueMs: event.queueMs, durationMs: event.durationMs, termination: event.termination, execution: event.execution, running: event.running}
          : {type: 'subagent_state', id: event.id, state: 'settled', mode: event.mode, queueMs: event.queueMs, durationMs: event.durationMs, termination: event.termination, execution: 'settled', running: event.running}))});
    turnScope.executionScope ??= assembled.executionScope;
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
        : [...stripSyntheticControls(callbacks.getConversation()), userTurnMessage(value, turnOptions.attachments ?? [])],
    ).messages;
    let requestMessages = durableRequestMessages;
    if (estimateValueTokens(requestMessages) > ACTIVE_CONTEXT_TOKEN_BUDGET) {
      requestMessages = compactModelMessages(requestMessages, {tokenBudget: ACTIVE_CONTEXT_TOKEN_BUDGET, workState: goal}).messages;
    }
    requestMessages = withoutSystemMessages(requestMessages);
    callbacks.setConversation(stripSyntheticControls(requestMessages));
    if (turnOptions.ephemeralControl) requestMessages = withSyntheticControl(requestMessages, turnOptions.ephemeralControl);

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
    const mutationPolicy = assembled.executionScope?.mutationPolicy ?? new WorkspaceMutationPolicy();
    const toolExecutionContext: HazeToolContext = {inFlightToolCalls: new Map<string, Promise<unknown>>(), loadedContextFilePaths: new Set(activeContextFiles.map(file => file.path)), loadedContextFileSignatures: contextFileSignatures, onContextFileRead: path => toolDisplay.addContextFileRead(path), mutationPolicy, blessedPaths: turnOptions.blessedPaths};
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
    let finishReason: string | undefined;
    let lastToolOk: boolean | undefined;
    let completedSteps = 0;
    let completedToolCalls = 0;
    let completedToolOnlySteps = 0;
    let pendingMalformedToolName: string | undefined;
    let unresolvedMalformedToolName: string | undefined;
    // Per-attempt (not per-turn) recovery counter: a transient retry gets a
    // fresh map. Bounded across the whole turn by MAIN_TOOL_CALL_LIMIT.
    const malformedRecoveryAttempts = new Map<string, number>();
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
      ...(!omitMaxOutputTokens ? {maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS} : {}),
      ...providerSettings,
      stopWhen: isStepCount(MAIN_STEP_LIMIT),
      runtimeContext: toolExecutionContext,
      toolsContext: toolsContextFor(availableTools, toolExecutionContext) as never,
      experimental_repairToolCall: async ({toolCall, error}) => {
        if (isMalformedToolInputError(error)) {
          pendingMalformedToolName = toolCall.toolName;
          unresolvedMalformedToolName = toolCall.toolName;
        }
        // Truncated generated file content cannot be reconstructed safely here;
        // let the next agent step retry under the bounded tool-choice constraint.
        return null;
      },
      prepareStep({steps, messages}) {
        const toolCalls = steps.flatMap(step => step.toolCalls);
        const repeatedToolNames = uniqueRepeatedToolNames(toolCalls);
        const scopedMessages = withScopedContextControl(messages, toolExecutionContext);
        const messagesChanged = scopedMessages !== messages;
        if (likelyPlanOnlyRequest && toolResultState.mutatingToolSucceeded) return messagesChanged ? {toolChoice: 'none' as const, messages: scopedMessages} : {toolChoice: 'none' as const};
        if (pendingMalformedToolName && pendingMalformedToolName in availableTools) {
          const toolName = pendingMalformedToolName as keyof typeof availableTools;
          const attempt = malformedRecoveryAttempts.get(String(toolName)) ?? 0;
          pendingMalformedToolName = undefined;
          if (attempt >= 2) {
            callbacks.debugLog(`malformed ${String(toolName)} recovery exhausted`);
            return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, `The ${String(toolName)} input remained invalid after two smaller retries. Report this as blocked; do not promise another retry or claim completion.`)};
          }
          malformedRecoveryAttempts.set(String(toolName), attempt + 1);
          callbacks.debugLog(`forcing smaller retry after malformed ${String(toolName)} input`);
          return {toolChoice: {type: 'tool' as const, toolName}, messages: withSyntheticControl(scopedMessages, malformedToolCallPrompt(String(toolName), WRITE_FILE_CHUNK_BYTES))};
        }
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
      onStepEnd({stepNumber, text, toolCalls, toolResults, finishReason, usage, response}) {
        completedSteps++;
        completedToolCalls += toolCalls.length;
        if (toolCalls.length > 0 && text.trim().length === 0) completedToolOnlySteps++;
        if (Array.isArray(response?.messages) && response.messages.length > 0) latestAccumulatedResponseMessages = response.messages as ModelMessage[];
        const stepUsage = stepCacheMetrics(usage);
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

    idleTimer.reset();
    const result = await agent.stream({messages: requestMessages, abortSignal: abortController.signal});

    for await (const part of result.stream) {
      idleTimer.reset();
      switch (part.type) {
        case 'text-delta': {
          callbacks.setBusyLabel?.(thinkingLabel);
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
          inFlightTools.add(part.id);
          callbacks.setBusyLabel?.(busyToolLabel(part.toolName, {}));
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
          // Tool execution begins only after its complete input has parsed and validated.
          startedTools.set(part.toolCallId, Date.now());
          callbacks.setBusyLabel?.(busyToolLabel(part.toolName, part.input));
          toolDisplay.ensureToolItem(toolCall).summary = toolCallSummary(part.toolName, part.input);
          toolDisplay.updateToolGroup(true);
          break;
        }
        case 'tool-result': {
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          inFlightTools.delete(part.toolCallId);
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          const ok = toolOutputOk(part.output, true);
          lastToolOk = ok;
          if (ok && part.toolName === unresolvedMalformedToolName) unresolvedMalformedToolName = undefined;
          const finish: NativeToolFinish = {toolCall, success: ok, output: part.output, durationMs: Date.now() - startedAt};
          const item = toolDisplay.ensureToolItem(toolCall);
          item.status = ok ? 'success' : 'error';
          item.result = toolResultSummary(finish);
          item.diff = toolDiffFromResult(toolCall, part.output);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: ok, output: part.output, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: ok, output: part.output, durationMs: finish.durationMs}});
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
          inFlightTools.delete(part.toolCallId);
          const existing = latestToolCalls.get(part.toolCallId);
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input ?? existing?.input};
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          lastToolOk = false;
          if (isMalformedToolInputError(part.error)) {
            pendingMalformedToolName = part.toolName;
            unresolvedMalformedToolName = part.toolName;
          }
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
          finishReason = part.finishReason;
          callbacks.debugLog(`ToolLoopAgent finished: ${part.finishReason}`);
          break;
        default:
          break;
      }
    }

    if (streamError && !streamFinished) {
      void Promise.resolve(result.responseMessages).catch(() => undefined);
      throw streamError;
    }

    try {
      const responseMessages = await result.responseMessages;
      const completedConversation = [...stripSyntheticControls(requestMessages), ...responseMessages];
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
      callbacks.addMessage({role: 'system', text: 'Tool work ended without a substantive final answer.'});
    }

    const budgetReached = finishReason === 'length'
      || completedSteps >= MAIN_STEP_LIMIT
      || completedToolCalls >= MAIN_TOOL_CALL_LIMIT
      || completedToolOnlySteps >= MAIN_TOOL_ONLY_STEP_LIMIT;
    turnStatus = terminalTurnStatus({aborted: false, assistantText, sawToolCall: latestToolCalls.size > 0, lastToolOk, finishReason, budgetReached, unresolvedToolInputError: unresolvedMalformedToolName != null});
    if (unresolvedMalformedToolName) callbacks.addMessage({role: 'system', text: `${unresolvedMalformedToolName} did not execute because its generated input remained invalid or truncated. The requested work is incomplete.`});
    goal.phase = 'done';
    goal.status = turnStatus === 'complete' ? 'complete' : 'blocked';
    callbacks.setWorkState?.(goal);
    callbacks.setGoalStatus?.(undefined);
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
          return {status: 'failed', retry: {attempt: retryAttempt, contextOverflowRecovered: true, delayMs: 0}};
        }
        callbacks.addMessage({role: 'system', text: 'Context overflow detected, but there was not enough conversation history to compact automatically.'});
      }
      const maxRetries = 2;
      if (retryAttempt < maxRetries && isRetryableModelError(error)) {
        const delay = retryDelayMs(retryAttempt);
        callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: maxRetries, delayMs: delay, error: text}));
        callbacks.addMessage({role: 'system', text: `Transient model error; retrying attempt ${retryAttempt + 1}/${maxRetries} in ${formatSeconds(delay)}: ${text}`});
        return {status: 'failed', retry: {attempt: retryAttempt + 1, contextOverflowRecovered, delayMs: delay}};
      }
      callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
    }
  } finally {
    if (loadedMcp?.clients.length) await closeMcpClients(loadedMcp.clients);
    idleTimer.clear();
    toolDisplay.stopToolTimer();
    toolDisplay.finalizeToolGroup();
  }
  return {status: turnStatus};
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
  const abortController = new AbortController();
  let status: TurnStatus = 'failed';
  callbacks.onEvent?.(agentEvent({type: 'turn_start', request: value}));
  callbacks.setBusy(true);
  callbacks.setAbortController?.(abortController);
  if (!retryingExistingRequest) callbacks.addMessage({role: 'user', text: displayValue ?? value});
  try {
    // Retries are one logical turn and therefore share coordinator admission and
    // the workspace mutation lease, including quarantined lingering work.
    const turnScope: {executionScope?: TurnExecutionScope} = {};
    let attempt = retryAttempt;
    let overflowRecovered = contextOverflowRecovered;
    let retrying = retryingExistingRequest;
    while (true) {
      const result = await runAgentAttempt(value, contextFiles, callbacks, attempt, retrying, overflowRecovered, session, modelOverride, abortController, turnOptions, turnScope);
      status = result.status;
      if (!result.retry) break;
      attempt = result.retry.attempt;
      overflowRecovered = result.retry.contextOverflowRecovered;
      retrying = true;
      if (result.retry.delayMs > 0) await abortableDelay(result.retry.delayMs, abortController.signal);
      if (abortController.signal.aborted) { status = 'aborted'; break; }
    }
    return {status};
  } finally {
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status}));
    callbacks.setAbortController?.(null);
    callbacks.setBusyLabel?.(modelThinkingLabel(undefined));
    callbacks.setBusy(false);
  }
}
