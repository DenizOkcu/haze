import {ToolLoopAgent, stepCountIs, type ModelMessage} from 'ai';
import type {LlmLog} from '../../core/log/llmLog.js';
import {appendLogEntry as logAppend, type LlmLogEntry} from '../../core/log/llmLog.js';
import {modelWithConfig, providerRequestSettings} from '../../llm/client.js';
import {assembleRequestContext} from '../../llm/requestContext.js';
import {type PromptSession} from '../../llm/systemPrompt.js';
import {closeMcpClients, type LoadedMcpTools} from '../../llm/mcp.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {compact, toolCallSummary, toolResultSummary, formatElapsedTimeWhole, formatSeconds} from './formatters.js';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../core/agent/errors.js';
import {isPlanOnlyRequest} from '../../core/goal/requestClassifier.js';
import {repeatedToolCallPrompt, toolLoopBudgetPrompt} from '../../core/goal/completionPolicy.js';
import {contextBreakdown, cacheHitRatio, effectiveNonCachedInput, estimateValueTokens} from '../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl} from '../../core/agent/requestAssembly.js';
import {compactModelMessages} from '../../core/agent/compaction.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent} from '../../core/goal/sessionGoal.js';
import type {WorkState} from '../../core/agent/workState.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number};

type NativeToolCall = {toolCallId: string; toolName: string; input: unknown};
type NativeToolFinish = {toolCall: NativeToolCall; success: boolean; output?: unknown; error?: unknown; durationMs: number};

function stableToolKey(toolCall: {toolName: string; input: unknown}) {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.input)}`;
}

export function uniqueRepeatedToolNames(toolCalls: Array<{toolName: string; input: unknown}>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const toolCall of toolCalls) {
    const key = stableToolKey(toolCall);
    if (seen.has(key)) repeated.add(toolCall.toolName);
    seen.add(key);
  }
  return [...repeated];
}

export function toolOnlyStepCount(steps: Array<{toolCalls: unknown[]; text: string}>) {
  let count = 0;
  for (const step of [...steps].reverse()) {
    if (step.toolCalls.length === 0 || step.text.trim().length > 0) break;
    count += 1;
  }
  return count;
}

function sanitizeAssistantText(text: string) {
  return [...text].filter(char => {
    const code = char.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 || code === 155);
  }).join('');
}

function hideSyntheticToolCallMarkup(text: string) {
  return text
    .replace(/(^|\n)\s*(?:```(?:xml)?\s*)?(?:xml\s*)?<tool_call>[\s\S]*?<\/tool_call>\s*(?:```)?/gi, '$1')
    .replace(/(^|\n)\s*(?:```(?:xml)?\s*)?(?:xml\s*)?<tool_call>[\s\S]*$/i, '$1');
}

function isWordChar(char: string) {
  return char.toLowerCase() !== char.toUpperCase() || (char >= '0' && char <= '9');
}

function wordCount(text: string) {
  let count = 0;
  let inWord = false;
  for (const char of text) {
    if (isWordChar(char)) {
      if (!inWord) count += 1;
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return count;
}

function endsWithSentenceBoundary(text: string) {
  const trimmed = text.trim();
  if (!trimmed || wordCount(trimmed) === 0) return false;
  const last = trimmed.at(-1) ?? '';
  return last === '.' || last === '!' || last === '?' || last === ':' || last === ';' || last === ')';
}

function isNonSubstantiveAssistantText(text: string) {
  return wordCount(text) === 0;
}

function isSubstantiveAssistantText(text: string) {
  const trimmed = text.trim();
  const words = wordCount(trimmed);
  if (words === 0) return false;
  if (trimmed.length >= 24) return true;
  if (endsWithSentenceBoundary(trimmed)) return true;
  return words >= 4;
}

function isIncompleteAssistantFragment(text: string) {
  const trimmed = text.trim();
  return !isSubstantiveAssistantText(trimmed) && wordCount(trimmed) <= 2 && !endsWithSentenceBoundary(trimmed);
}

function isLikelyUnfinishedMarkdownFragment(text: string) {
  const trimmed = text.trim();
  if (!trimmed.includes('\n')) return false;
  const last = trimmed.at(-1) ?? '';
  return last === '-' || last === '*' || last === '#' || last === '`' || last === '>';
}

export function isShortUnfinishedBridgeBeforeTool(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0 && wordCount(trimmed) <= 12 && !endsWithSentenceBoundary(trimmed) && !isLikelyUnfinishedMarkdownFragment(trimmed);
}

function isHiddenAssistantText(text: string) {
  return text.length === 0 || isNonSubstantiveAssistantText(text);
}

function isHiddenAssistantFragment(text: string) {
  return isHiddenAssistantText(text) || isIncompleteAssistantFragment(text) || isLikelyUnfinishedMarkdownFragment(text);
}

export function isHiddenUnstartedFinalText(text: string) {
  return isHiddenAssistantText(text) || isLikelyUnfinishedMarkdownFragment(text);
}

const ASSISTANT_STREAM_DEBOUNCE_MS = 200;

export function shouldStartAssistantStream(text: string, startedAt: number) {
  if (isHiddenAssistantFragment(text)) return false;
  return isSubstantiveAssistantText(text) || Date.now() - startedAt >= ASSISTANT_STREAM_DEBOUNCE_MS;
}

function assistantDisplayText(text: string) {
  return hideSyntheticToolCallMarkup(text).trim();
}

function normalizeAssistantText(text: string) {
  return assistantDisplayText(text)
    .replace(/[`*_~#>\-–—:;,.!?()[\]{}"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function toolInputPath(input: unknown) {
  return typeof input === 'object' && input != null && 'path' in input && typeof (input as {path?: unknown}).path === 'string'
    ? (input as {path: string}).path
    : undefined;
}

function isDuplicateSkippedOutput(output: unknown) {
  return typeof output === 'object' && output != null && 'duplicateSkipped' in output && (output as {duplicateSkipped?: unknown}).duplicateSkipped === true;
}

function retryDelayMs(attempt: number) {
  return Math.min(4000, 1000 * 2 ** attempt);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, {once: true});
  });
}

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAIN_STEP_LIMIT = 64;
const MAIN_TOOL_CALL_LIMIT = 120;
const MAIN_TOOL_ONLY_STEP_LIMIT = 24;
const ACTIVE_CONTEXT_TOKEN_BUDGET = 40_000;

function toolOutputOk(output: unknown, success: boolean) {
  if (!success) return false;
  return !(typeof output === 'object' && output != null && 'ok' in output && (output as {ok?: unknown}).ok === false);
}

export interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  systemPrompt: number;
  messages: number;
  toolSchemas: number;
  outputEstimate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  reasoningTokens: number;
  logicalInputEstimate: number;
  effectiveNonCachedInput: number | undefined;
}

function estimateInputBreakdown(input: {system: string; contextFiles: ContextFile[]; messages: ModelMessage[]; tools?: Record<string, unknown>}) {
  const breakdown = contextBreakdown(input);
  return {
    breakdown,
    systemPrompt: breakdown.system,
    messages: Object.values(breakdown.messagesByRole).reduce((sum, value) => sum + value, 0),
    toolSchemas: breakdown.toolSchemas.reduce((sum, value) => sum + value.tokens, 0),
    logicalInputEstimate: breakdown.logicalInputEstimate,
  };
}

function logEntry(log: LlmLog | undefined, entry: LlmLogEntry) {
  if (log) void logAppend(log, entry).catch(() => undefined);
}

function responseCompletionMetrics(text: string, generationStartedAt: number) {
  const finishedAt = Date.now();
  const elapsedSeconds = Math.max((finishedAt - generationStartedAt) / 1000, 0.001);
  const outputTokens = estimateValueTokens(text);
  return {
    finishedAt,
    tokensPerSecond: outputTokens > 0 ? outputTokens / elapsedSeconds : undefined,
  };
}

function extractUsage(event: {usage?: {inputTokens?: number; outputTokens?: number; inputTokenDetails?: {cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number}; outputTokenDetails?: {reasoningTokens?: number}}}) {
  const cacheReadTokens = event.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  return {
    inputTokens: event.usage?.inputTokens,
    outputTokens: event.usage?.outputTokens,
    cacheReadTokens,
    cacheWriteTokens: event.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    noCacheTokens: event.usage?.inputTokenDetails?.noCacheTokens ?? effectiveNonCachedInput(event.usage?.inputTokens, cacheReadTokens) ?? 0,
    reasoningTokens: event.usage?.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

function subagentTokenEstimate(output: unknown) {
  if (typeof output !== 'object' || output == null || !('tokens' in output)) return undefined;
  const tokens = (output as {tokens?: {in?: unknown; out?: unknown}}).tokens;
  const input = typeof tokens?.in === 'number' ? tokens.in : 0;
  const outputTokens = typeof tokens?.out === 'number' ? tokens.out : 0;
  return input > 0 || outputTokens > 0 ? {input, output: outputTokens} : undefined;
}

function rememberContextFilesFromToolOutput(activeContextFiles: ContextFile[], output: unknown) {
  if (typeof output !== 'object' || output == null) return activeContextFiles;
  const files = (output as {applicableProjectInstructions?: unknown}).applicableProjectInstructions;
  if (!Array.isArray(files)) return activeContextFiles;
  const seen = new Set(activeContextFiles.map(file => file.path));
  const next = [...activeContextFiles];
  for (const file of files) {
    if (typeof file !== 'object' || file == null) continue;
    const candidate = file as {path?: unknown; content?: unknown};
    if (typeof candidate.path !== 'string' || typeof candidate.content !== 'string' || seen.has(candidate.path)) continue;
    next.push({path: candidate.path, content: candidate.content});
    seen.add(candidate.path);
  }
  return next;
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
): Promise<void> {
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

  type ToolDisplayItem = {id: string; summary: string; status: 'running' | 'success' | 'error'; result?: string; startedAt: number; finishedAt?: number; durationMs?: number};
  type ToolDisplayGroup = {id: string; items: ToolDisplayItem[]; started: boolean; finalized: boolean};
  const createToolGroup = (): ToolDisplayGroup => ({id: `tools-${Date.now()}-${Math.random().toString(36).slice(2)}`, items: [], started: false, finalized: false});
  let toolGroup = createToolGroup();
  let toolTimer: ReturnType<typeof setInterval> | undefined;
  const renderToolGroup = (group = toolGroup) => {
    const running = group.items.some(item => item.status === 'running');
    const failures = group.items.filter(item => item.status === 'error').length;
    const changes = group.items.filter(item => /^(editFile|replaceLines|writeFile)\b/.test(item.summary)).length;
    const elapsedMs = group.items.length > 0
      ? (running ? Date.now() : Math.max(...group.items.map(item => item.finishedAt ?? item.startedAt))) - Math.min(...group.items.map(item => item.startedAt))
      : 0;
    const summaryParts = [`${group.items.length} calls`, `${changes} changes`];
    if (failures > 0) summaryParts.push(`${failures} failed`);
    summaryParts.push(formatElapsedTimeWhole(elapsedMs));
    return [summaryParts.join(' · '), ...group.items.map(item => {
      const icon = item.status === 'running' ? '…' : item.status === 'success' ? '✓' : '✗';
      const result = item.status === 'running' ? '' : ` — ${item.result ?? item.status}${item.durationMs == null ? '' : ` in ${formatSeconds(item.durationMs)}`}`;
      return `  ${icon} ${item.summary}${result}`;
    })].join('\n');
  };
  const updateToolGroup = (streaming = true, group = toolGroup) => {
    const text = renderToolGroup(group);
    if (!group.started) {
      group.started = true;
      group.finalized = !streaming;
      callbacks.addMessage({id: group.id, role: 'tool', text, streaming});
    } else {
      group.finalized = !streaming;
      callbacks.updateMessage(group.id, {text, streaming});
    }
  };
  const finalizeToolGroup = (group = toolGroup) => {
    if (!group.started || group.finalized) return;
    updateToolGroup(false, group);
  };
  const startFreshToolGroup = () => {
    if (!toolGroup.started || toolGroup.items.some(item => item.status === 'running')) return;
    finalizeToolGroup(toolGroup);
    toolGroup = createToolGroup();
  };
  const stopToolTimer = () => {
    if (!toolTimer) return;
    clearInterval(toolTimer);
    toolTimer = undefined;
  };
  const startToolTimer = () => {
    if (toolTimer) return;
    toolTimer = setInterval(() => {
      if (toolGroup.items.some(item => item.status === 'running')) updateToolGroup(true);
      else stopToolTimer();
    }, 1000);
  };
  const ensureToolItem = (toolCall: NativeToolCall) => {
    if (toolGroup.finalized) toolGroup = createToolGroup();
    let item = toolGroup.items.find(candidate => candidate.id === toolCall.toolCallId);
    if (!item) {
      item = {id: toolCall.toolCallId, summary: toolCallSummary(toolCall.toolName, toolCall.input), status: 'running', startedAt: Date.now()};
      toolGroup.items.push(item);
      callbacks.onEvent?.(agentEvent({type: 'tool_start', id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}));
      logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_call', stream: 'main', toolCall: {id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}});
      callbacks.debugLog(`tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
      startToolTimer();
      updateToolGroup(true);
    }
    return item;
  };

  try {
    const runtime = await modelWithConfig(session ? {cwd: session.cwd} : undefined);
    if (!runtime?.model) {
      callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. Haze cannot hallucinate without a model. Progress.'});
      turnStatus = 'complete';
      return;
    }

    let activeContextFiles = contextFiles;
    const activeModel = runtime.model;
    const providerSettings = providerRequestSettings(runtime.config);
    const assembled = await assembleRequestContext({contextFiles: activeContextFiles, session, model: activeModel});
    const availableTools = assembled.availableTools;
    loadedMcp = assembled.loadedMcp;
    if (loadedMcp?.errors.length) callbacks.addMessage({role: 'system', text: `MCP: ${loadedMcp.errors.join('; ')}`});

    const goal = createSessionGoal(value);
    callbacks.setWorkState?.(goal.workState);
    callbacks.setGoalStatus?.(formatGoalStatus(goal));
    const likelyPlanOnlyRequest = isPlanOnlyRequest(value);

    const durableRequestMessages = compactToolHistory(
      retryingExistingRequest
        ? stripSyntheticControls(callbacks.getConversation())
        : [...stripSyntheticControls(callbacks.getConversation()), {role: 'user', content: value}],
    ).messages;
    let requestMessages = durableRequestMessages;
    if (estimateValueTokens(requestMessages) > ACTIVE_CONTEXT_TOKEN_BUDGET) {
      requestMessages = compactModelMessages(requestMessages, {tokenBudget: ACTIVE_CONTEXT_TOKEN_BUDGET, workState: goal.workState}).messages;
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

    const toolExecutionContext = {inFlightToolCalls: new Map<string, Promise<unknown>>(), loadedContextFilePaths: new Set(activeContextFiles.map(file => file.path))};
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
    let mutatingToolSucceeded = false;
    let editRecoveryPath: string | undefined;
    let editRecoveryReadSatisfied = false;
    const resetAssistantSegment = () => {
      currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      assistantStarted = false;
      assistantStartedAt = Date.now();
      currentAssistantText = '';
    };
    const finalizeAssistantSegment = (options: {beforeTool?: boolean} = {}) => {
      const finalText = assistantDisplayText(currentAssistantText);
      const normalized = normalizeAssistantText(finalText);
      const hidden = (assistantStarted ? isHiddenAssistantFragment(finalText) : isHiddenUnstartedFinalText(finalText)) || (options.beforeTool === true && isShortUnfinishedBridgeBeforeTool(finalText)) || (normalized.length > 0 && visibleAssistantTexts.has(normalized));
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
        if (likelyPlanOnlyRequest && mutatingToolSucceeded) return {toolChoice: 'none'};
        if (editRecoveryPath && !editRecoveryReadSatisfied) return {activeTools: ['readFile'] as Array<keyof typeof availableTools>};
        if (repeatedToolNames.length > 0) {
          const activeTools = (Object.keys(availableTools) as Array<keyof typeof availableTools>).filter(name => !repeatedToolNames.includes(name as string));
          callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
          return activeTools.length > 0
            ? {activeTools, messages: withSyntheticControl(messages, repeatedToolCallPrompt(repeatedToolNames))}
            : {toolChoice: 'none', messages: withSyntheticControl(messages, repeatedToolCallPrompt(repeatedToolNames))};
        }
        if (toolCalls.length >= MAIN_TOOL_CALL_LIMIT || toolOnlyStepCount(steps) >= MAIN_TOOL_ONLY_STEP_LIMIT) {
          callbacks.debugLog('forcing text response to avoid tool loop');
          return {toolChoice: 'none', messages: withSyntheticControl(messages, toolLoopBudgetPrompt())};
        }
        return undefined;
      },
      onStepFinish({stepNumber, text, toolCalls, toolResults, finishReason, usage, response}) {
        if (Array.isArray(response?.messages) && response.messages.length > 0) latestAccumulatedResponseMessages = response.messages as ModelMessage[];
        const stepInputTokens = usage?.inputTokens;
        const stepOutputTokens = usage?.outputTokens;
        const stepCacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        const stepCacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
        const stepReasoning = usage?.outputTokenDetails?.reasoningTokens ?? 0;
        const stepNoCache = effectiveNonCachedInput(stepInputTokens, stepCacheRead) ?? 0;
        const stepCacheHitRatio = cacheHitRatio(stepInputTokens, stepCacheRead || undefined);
        logEntry(callbacks.log, {at: new Date().toISOString(), type: 'step', stream: 'main', step: stepNumber, text, finishReason, usage: {inputTokens: stepInputTokens, outputTokens: stepOutputTokens, cacheReadTokens: stepCacheRead || undefined, cacheWriteTokens: stepCacheWrite || undefined, noCacheTokens: stepNoCache || undefined, reasoningTokens: stepReasoning || undefined, cacheHitRatio: stepCacheHitRatio}});
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
          effectiveNonCachedInput: effectiveNonCachedInput(providerUsage.inputTokens, providerUsage.cacheReadTokens),
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
          startFreshToolGroup();
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
          if (currentAssistantText.trim().length > 0 || assistantStarted) finalizeAssistantSegment({beforeTool: true});
          const toolCall = {toolCallId: part.id, toolName: part.toolName, input: {}};
          latestToolCalls.set(part.id, toolCall);
          startedTools.set(part.id, Date.now());
          ensureToolItem(toolCall);
          break;
        }
        case 'tool-call': {
          if (currentAssistantText.trim().length > 0 || assistantStarted) finalizeAssistantSegment({beforeTool: true});
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          if (!startedTools.has(part.toolCallId)) startedTools.set(part.toolCallId, Date.now());
          ensureToolItem(toolCall).summary = toolCallSummary(part.toolName, part.input);
          updateToolGroup(true);
          break;
        }
        case 'tool-result': {
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input};
          latestToolCalls.set(part.toolCallId, toolCall);
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          const finish: NativeToolFinish = {toolCall, success: true, output: part.output, durationMs: Date.now() - startedAt};
          const item = ensureToolItem(toolCall);
          item.status = toolOutputOk(part.output, true) ? 'success' : 'error';
          item.result = toolResultSummary(finish);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: true, output: part.output, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: true, output: part.output, durationMs: finish.durationMs}});
          const ok = toolOutputOk(part.output, true);
          const path = toolInputPath(toolCall.input);
          if (!ok && ['editFile', 'replaceLines', 'writeFile'].includes(toolCall.toolName)) {
            editRecoveryPath = path;
            editRecoveryReadSatisfied = false;
          }
          if (ok && toolCall.toolName === 'readFile' && path && path === editRecoveryPath && !isDuplicateSkippedOutput(part.output)) {
            editRecoveryReadSatisfied = true;
          }
          if (ok && !isDuplicateSkippedOutput(part.output) && ['editFile', 'replaceLines', 'writeFile'].includes(toolCall.toolName)) {
            mutatingToolSucceeded = true;
            if (!path || path === editRecoveryPath) {
              editRecoveryPath = undefined;
              editRecoveryReadSatisfied = false;
            }
          }
          observeGoalToolEvent(goal, {...toolCall, success: ok, output: part.output, duplicateSkipped: isDuplicateSkippedOutput(part.output)});
          callbacks.setWorkState?.(goal.workState);
          callbacks.setGoalStatus?.(formatGoalStatus(goal));
          activeContextFiles = rememberContextFilesFromToolOutput(activeContextFiles, part.output);
          if (toolCall.toolName === 'writeTasks') callbacks.onTasksChanged?.();
          const nestedTokens = subagentTokenEstimate(part.output);
          if (nestedTokens) callbacks.recordTokenUsage?.({inputTokens: nestedTokens.input, outputTokens: nestedTokens.output, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: nestedTokens.input, reasoningTokens: 0, logicalInputEstimate: nestedTokens.input, effectiveNonCachedInput: nestedTokens.input});
          updateToolGroup(true);
          break;
        }
        case 'tool-error': {
          const existing = latestToolCalls.get(part.toolCallId);
          const toolCall = {toolCallId: part.toolCallId, toolName: part.toolName, input: part.input ?? existing?.input};
          const startedAt = startedTools.get(part.toolCallId) ?? Date.now();
          const finish: NativeToolFinish = {toolCall, success: false, error: part.error, durationMs: Date.now() - startedAt};
          const item = ensureToolItem(toolCall);
          item.status = 'error';
          item.result = toolResultSummary(finish);
          item.durationMs = finish.durationMs;
          item.finishedAt = startedAt + finish.durationMs;
          callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, error: part.error, durationMs: finish.durationMs}));
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: false, error: part.error, durationMs: finish.durationMs}});
          if (['editFile', 'replaceLines', 'writeFile'].includes(toolCall.toolName)) {
            editRecoveryPath = toolInputPath(toolCall.input);
            editRecoveryReadSatisfied = false;
          }
          observeGoalToolEvent(goal, {...toolCall, success: false, error: part.error});
          callbacks.setWorkState?.(goal.workState);
          callbacks.setGoalStatus?.(formatGoalStatus(goal));
          updateToolGroup(true);
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
      const fallback = `Finished tool work.${toolInputPath([...latestToolCalls.values()].at(-1)?.input) ? '' : ''}`;
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
          await runAgentTurn(value, displayValue, contextFiles, callbacks, retryAttempt, true, true, session);
          return;
        }
        callbacks.addMessage({role: 'system', text: 'Context overflow detected, but there was not enough conversation history to compact automatically.'});
      }
      const maxRetries = 2;
      if (retryAttempt < maxRetries && isRetryableModelError(error)) {
        const delay = retryDelayMs(retryAttempt);
        callbacks.onEvent?.(agentEvent({type: 'retry', attempt: retryAttempt + 1, maxAttempts: maxRetries, delayMs: delay, error: text}));
        callbacks.addMessage({role: 'system', text: `Transient model error; retrying attempt ${retryAttempt + 1}/${maxRetries} in ${formatSeconds(delay)}: ${text}`});
        await abortableDelay(delay, abortController.signal);
        if (abortController.signal.aborted) return;
        await runAgentTurn(value, displayValue, contextFiles, callbacks, retryAttempt + 1, true, contextOverflowRecovered, session);
        return;
      }
      callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
    }
  } finally {
    if (loadedMcp?.clients.length) await closeMcpClients(loadedMcp.clients);
    if (idleTimer) clearTimeout(idleTimer);
    stopToolTimer();
    finalizeToolGroup();
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status: turnStatus}));
    callbacks.setAbortController?.(null);
    callbacks.setBusyLabel?.('Haze is thinking');
    callbacks.setBusy(false);
  }
}
