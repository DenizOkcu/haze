import {stepCountIs, streamText, type ModelMessage} from 'ai';
import type {LlmLog} from '../../core/log/llmLog.js';
import {appendLogEntry as logAppend, type LlmLogEntry} from '../../core/log/llmLog.js';
import {modelWithConfig, providerRequestSettings} from '../../llm/client.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {buildSystemPrompt, type PromptSession} from '../../llm/systemPrompt.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {buildSkillTools} from '../../skills/skillTools.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {compact, toolCallSummary, toolResultSummary, formatElapsedTimeWhole, formatSeconds} from './formatters.js';
import {isActionRequest, isPlanImplementationRequest, isPlanOnlyRequest, isValidationRequest} from '../../core/goal/requestClassifier.js';
import {completionDecision, looksIncomplete, noTextAfterToolPrompt, postContinuationPrompt, repeatedToolCallPrompt, toolLoopBudgetPrompt} from '../../core/goal/completionPolicy.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent} from '../../core/goal/sessionGoal.js';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../core/agent/errors.js';
import {createSubagentTool} from '../../core/subagent/subagentRunner.js';
import {contextBreakdown, cacheHitRatio, effectiveNonCachedInput, estimateValueTokens} from '../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, toolRequestSettings, withSyntheticControl} from '../../core/agent/requestAssembly.js';
import {compactModelMessages} from '../../core/agent/compaction.js';
import {workStatePrompt, type WorkState} from '../../core/agent/workState.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean; startedAt?: number; finishedAt?: number; tokensPerSecond?: number; displayOrder?: number};

function stableToolKey(toolCall: {toolName: string; input: unknown}) {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.input)}`;
}

function uniqueRepeatedToolNames(toolCalls: Array<{toolName: string; input: unknown}>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const toolCall of toolCalls) {
    const key = stableToolKey(toolCall);
    if (seen.has(key)) repeated.add(toolCall.toolName);
    seen.add(key);
  }
  return [...repeated] as Array<keyof typeof hazeTools>;
}

function toolOnlyStepCount(steps: Array<{toolCalls: unknown[]; text: string}>) {
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
// The step limit is the primary per-turn cost ceiling. The tool-call limits sit
// above it so healthy autonomous runs (read -> edit -> validate per todo item)
// complete in one turn instead of being interrupted by a blunt count ceiling.
// True tool loops are steered by duplicate-call nudges and the tool-only-step
// guard below, not by these count limits.
const MAIN_STEP_LIMIT = 64;
const MAIN_TOOL_CALL_LIMIT = 120;
const MAIN_TOOL_ONLY_STEP_LIMIT = 24;
const FOLLOW_UP_STEP_LIMIT = 64;
const FOLLOW_UP_TOOL_CALL_LIMIT = 120;
const FOLLOW_UP_TOOL_ONLY_STEP_LIMIT = 24;
const COMPLETION_CONTINUATION_LIMIT = 12;
const ACTIVE_CONTEXT_TOKEN_BUDGET = 40_000;

function toolOutputOk(output: unknown, success: boolean) {
  if (!success) return false;
  return !(typeof output === 'object' && output != null && 'ok' in output && (output as {ok?: unknown}).ok === false);
}

export interface TokenUsage {
  /** Precise input tokens from the provider (undefined if provider doesn't report). */
  inputTokens: number | undefined;
  /** Precise output tokens from the provider (undefined if provider doesn't report). */
  outputTokens: number | undefined;
  /** Estimated system prompt tokens. */
  systemPrompt: number;
  /** Estimated message history tokens. */
  messages: number;
  /** Estimated tool schema tokens. */
  toolSchemas: number;
  /** Estimated output tokens (from response messages). */
  outputEstimate: number;
  /** Cached input tokens (if provider reports). */
  cacheReadTokens: number;
  /** Cache write tokens (if provider reports). */
  cacheWriteTokens: number;
  /** Provider-reported input tokens that were not served from cache. */
  noCacheTokens: number;
  /** Reasoning tokens (if provider reports). */
  reasoningTokens: number;
  /** Estimated complete logical request size. */
  logicalInputEstimate: number;
  /** Provider input minus cache reads, when provider usage is available. */
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

function subagentTokenEstimate(output: unknown) {
  if (typeof output !== 'object' || output == null || !('tokens' in output)) return undefined;
  const tokens = (output as {tokens?: {in?: unknown; out?: unknown}}).tokens;
  const input = typeof tokens?.in === 'number' ? tokens.in : 0;
  const outputTokens = typeof tokens?.out === 'number' ? tokens.out : 0;
  return input > 0 || outputTokens > 0 ? {input, output: outputTokens} : undefined;
}

function extractUsage(event: {usage?: {inputTokens?: number; outputTokens?: number; inputTokenDetails?: {cacheReadTokens?: number; cacheWriteTokens?: number}; outputTokenDetails?: {reasoningTokens?: number}}}) {
  const cacheReadTokens = event.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const reportedNoCache = 'noCacheTokens' in (event.usage?.inputTokenDetails ?? {})
    ? (event.usage?.inputTokenDetails as {noCacheTokens?: number}).noCacheTokens
    : undefined;
  return {
    inputTokens: event.usage?.inputTokens,
    outputTokens: event.usage?.outputTokens,
    cacheReadTokens,
    cacheWriteTokens: event.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    noCacheTokens: reportedNoCache ?? effectiveNonCachedInput(event.usage?.inputTokens, cacheReadTokens) ?? 0,
    reasoningTokens: event.usage?.outputTokenDetails?.reasoningTokens ?? 0,
  };
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
  const userMessage: Message = {role: 'user', text: displayVal};
  callbacks.onEvent?.(agentEvent({type: 'turn_start', request: value}));
  callbacks.setBusy(true);
  if (!retryingExistingRequest) callbacks.addMessage(userMessage);
  const abortController = new AbortController();
  callbacks.setAbortController?.(abortController);
  let turnStatus: 'complete' | 'aborted' | 'failed' = 'failed';
  type TurnStopReason = {
    kind: 'step_limit' | 'tool_budget' | 'tool_only_limit' | 'text_repetition' | 'tool_repetition' | 'idle_timeout';
    message: string;
  };
  let turnStopReason: TurnStopReason | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopActiveTimers: () => void = () => undefined;
  let finalizeToolGroup: () => void = () => undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      turnStopReason = {kind: 'idle_timeout', message: `Stopped after ${Math.round(IDLE_TIMEOUT_MS / 60_000)} minutes of no activity. Type "continue" to resume — Haze will pick up where it left off.`};
      abortController.abort('Haze turn timed out after no model/tool activity.');
    }, IDLE_TIMEOUT_MS);
  };

  try {
    const runtime = await modelWithConfig(session ? {cwd: session.cwd} : undefined);
    if (!runtime?.model) {
      callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. Haze cannot hallucinate without a model. Progress.'});
      return;
    }
    const activeModel = runtime.model;
    const providerSettings = providerRequestSettings(runtime.config);
    let activeContextFiles = [...contextFiles];
    const rememberContextFiles = (files: unknown) => {
      if (!Array.isArray(files)) return;
      const seen = new Set(activeContextFiles.map(file => file.path));
      for (const file of files) {
        if (typeof file !== 'object' || file == null) continue;
        const candidate = file as {path?: unknown; content?: unknown};
        if (typeof candidate.path !== 'string' || typeof candidate.content !== 'string' || seen.has(candidate.path)) continue;
        activeContextFiles = [...activeContextFiles, {path: candidate.path, content: candidate.content}];
        seen.add(candidate.path);
      }
    };
    const skillRegistry = await loadSkillRegistry();
    const subagentTool = createSubagentTool({model: activeModel, contextFiles: activeContextFiles, session});
    const availableTools = {...hazeTools, subagent: subagentTool, ...buildSkillTools(skillRegistry)};
    const goal = createSessionGoal(value);
    callbacks.setWorkState?.(goal.workState);
    callbacks.setGoalStatus?.(formatGoalStatus(goal));
    const likelyPlanOnlyRequest = isPlanOnlyRequest(value);
    const likelyPlanImplementationRequest = isPlanImplementationRequest(value);
    const likelyActionRequest = isActionRequest(value);
    const likelyValidationRequest = isValidationRequest(value);
    const planImplementationGuidance = 'Haze internal guidance for implementing plan files. The original user request remains authoritative. First identify the concrete required checklist items and compare them with the current files. Do not edit source or tests when the required behavior is already present. Implement the smallest clearly required phase or required items, skip optional/design-question items unless explicitly requested, add tests rather than exploratory one-off scripts where possible, prefer file tools for source changes, run validation once after code/test edits, then update plan status with file tools if requested. Do not call unresolved optional scope a blocker.';
    const durableRequestMessages: ModelMessage[] = compactToolHistory(
      retryingExistingRequest
        ? stripSyntheticControls(callbacks.getConversation())
        : [...stripSyntheticControls(callbacks.getConversation()), {role: 'user', content: value}],
    ).messages;
    let requestMessages = likelyPlanImplementationRequest
      ? withSyntheticControl(durableRequestMessages, planImplementationGuidance)
      : durableRequestMessages;
    if (estimateValueTokens(requestMessages) > ACTIVE_CONTEXT_TOKEN_BUDGET) {
      requestMessages = compactModelMessages(requestMessages, {tokenBudget: ACTIVE_CONTEXT_TOKEN_BUDGET, workState: goal.workState}).messages;
    }
    callbacks.setConversation(stripSyntheticControls(requestMessages));
    resetIdleTimer();
    let currentAssistantId = `assistant-${Date.now()}`;
    let assistantStarted = false;
    let currentAssistantStarted = false;
    let currentAssistantStartedAt = Date.now();
    let currentAssistantText = '';
    let assistantText = '';
    let toolEpoch = 0;
    let currentAssistantToolEpoch = 0;
    let editFileFailed = false;
    let mutatingToolSucceeded = false;
    let validationToolSucceeded = false;
    let validationToolFailed = false;
    let sawReadOnlyTool = false;
    let sawToolCall = false;
    let textAfterTool = false;
    let completionContinuationCount = 0;
    const maxCompletionContinuations = COMPLETION_CONTINUATION_LIMIT;
    const recentStepTextSignatures: string[] = [];
    let consecutiveTextOnlySteps = 0;
    let repetitionAbortFired = false;
    const warnedRepeatedToolSignatures = new Set<string>();
    const toolCallSignatureCounts = new Map<string, number>();
    const TOOL_REPETITION_THRESHOLD = 3;
    let latestAccumulatedResponseMessages: ModelMessage[] = [];
    let editRecoveryPath: string | undefined;
    let editRecoveryReasonCode: string | undefined;
    let editRecoveryReadSatisfied = false;
    const toolSummaries: string[] = [];
    const visibleAssistantTexts = new Set<string>();
    const previousAssistantText = normalizeAssistantText(callbacks.getLastAssistantText());
    if (previousAssistantText) visibleAssistantTexts.add(previousAssistantText);
    const rememberVisibleAssistantText = (text: string) => {
      const normalized = normalizeAssistantText(text);
      if (!normalized) return;
      visibleAssistantTexts.add(normalized);
      callbacks.setLastAssistantText(text);
    };
    const isDuplicateVisibleAssistantText = (text: string) => {
      const normalized = normalizeAssistantText(text);
      return normalized.length > 0 && visibleAssistantTexts.has(normalized);
    };
    const isPrefixOfVisibleAssistantText = (text: string) => {
      const normalized = normalizeAssistantText(text);
      return normalized.length > 0 && [...visibleAssistantTexts].some(previous => previous.startsWith(normalized) && previous !== normalized);
    };
    const toolExecutionContext = {inFlightToolCalls: new Map<string, Promise<unknown>>(), loadedContextFilePaths: new Set(activeContextFiles.map(file => file.path))};
    const INLINE_DIFF_LINE_LIMIT = 20;
    type ToolDiffLine = {type: 'add' | 'remove' | 'context'; oldLine?: number; newLine?: number; text: string};
    type ToolDisplayItem = {id: string; summary: string; status: 'running' | 'success' | 'error'; result?: string; durationMs?: number; startedAt: number; finishedAt?: number; subItems?: Array<{name: string; summary: string; durationMs: number}>; diff?: ToolDiffLine[]; diffLineCount?: number};
    type ToolDisplayGroup = {id: string; items: ToolDisplayItem[]; started: boolean};
    const createToolDisplayGroup = (): ToolDisplayGroup => ({id: `tools-${Date.now()}-${Math.random().toString(36).slice(2)}`, items: [], started: false});
    let activeToolGroup = createToolDisplayGroup();
    let assistantSinceActiveToolGroup = false;
    let toolTimer: ReturnType<typeof setInterval> | undefined;

    function stopToolTimer() {
      if (!toolTimer) return;
      clearInterval(toolTimer);
      toolTimer = undefined;
    }

    function startToolTimer() {
      if (toolTimer) return;
      toolTimer = setInterval(() => {
        if (activeToolGroup.items.some(item => item.status === 'running')) updateToolGroup(activeToolGroup, true);
        else stopToolTimer();
      }, 1000);
    }
    stopActiveTimers = stopToolTimer;

    function renderToolGroup(group: ToolDisplayGroup, _streaming: boolean) {
      const running = group.items.some(item => item.status === 'running');
      const failures = group.items.filter(item => item.status === 'error');
      const changes = group.items.filter(item => /^(editFile|replaceLines|writeFile)\b/.test(item.summary));
      const elapsedMs = group.items.length > 0
        ? (running ? Date.now() : Math.max(...group.items.map(item => item.finishedAt ?? item.startedAt))) - Math.min(...group.items.map(item => item.startedAt))
        : 0;
      const elapsed = formatElapsedTimeWhole(elapsedMs);
      const summaryParts = [`${group.items.length} calls`, `${changes.length} changes`];
      if (failures.length > 0) summaryParts.push(`${failures.length} failed`);
      summaryParts.push(elapsed);
      const summary = summaryParts.join(' · ');
      const header = summary;
      const lines: string[] = [];
      for (const item of group.items) {
        const icon = item.status === 'running' ? '…' : item.status === 'success' ? '✓' : '✗';
        const result = item.status === 'running' ? '' : ` — ${item.result ?? item.status}${item.durationMs == null ? '' : ` in ${formatSeconds(item.durationMs)}`}`;
        lines.push(`  ${icon} ${item.summary}${result}`);
        if (item.diff && item.diff.length > 0 && (item.diffLineCount ?? item.diff.length) <= INLINE_DIFF_LINE_LIMIT) {
          for (const diffLine of item.diff) {
            const lineNumber = diffLine.type === 'add' ? diffLine.newLine : diffLine.oldLine;
            const marker = diffLine.type === 'add' ? '+' : diffLine.type === 'remove' ? '-' : ' ';
            lines.push(`    ${String(lineNumber ?? '').padStart(5)} ${marker} ${diffLine.text}`);
          }
        } else if ((item.diffLineCount ?? 0) > INLINE_DIFF_LINE_LIMIT) {
          lines.push(`          diff hidden (${item.diffLineCount} changed lines; run git diff to inspect)`);
        }
        if (item.subItems && item.subItems.length > 0) {
          for (const sub of item.subItems) {
            const subDuration = sub.durationMs > 1000 ? ` · ${formatSeconds(sub.durationMs)}` : '';
            lines.push(`    · ${sub.name} — ${sub.summary}${subDuration}`);
          }
        }
      }
      return [header, ...lines].join('\n');
    }

    function updateToolGroup(group = activeToolGroup, streaming = true) {
      const text = renderToolGroup(group, streaming);
      if (!group.started) {
        group.started = true;
        callbacks.addMessage({id: group.id, role: 'tool', text, streaming});
      } else {
        callbacks.updateMessage(group.id, {text, streaming});
      }
    }
    finalizeToolGroup = () => {
      if (activeToolGroup.started) updateToolGroup(activeToolGroup, false);
    };

    function closeToolGroupBeforeAssistantMessage() {
      if (!activeToolGroup.started) return undefined;
      const relatedToolStartedAt = activeToolGroup.items.length > 0
        ? Math.min(...activeToolGroup.items.map(item => item.startedAt))
        : undefined;
      updateToolGroup(activeToolGroup, false);
      assistantSinceActiveToolGroup = true;
      return relatedToolStartedAt;
    }

    function toolGroupForNextCall() {
      const hasRunningTools = activeToolGroup.items.some(item => item.status === 'running');
      if (assistantSinceActiveToolGroup && activeToolGroup.started && !hasRunningTools) {
        activeToolGroup = createToolDisplayGroup();
        assistantSinceActiveToolGroup = false;
      }
      return activeToolGroup;
    }

    function ensureToolDisplayItem(toolCall: {toolCallId: string; toolName: string; input: unknown}) {
      let item = activeToolGroup.items.find(candidate => candidate.id === toolCall.toolCallId);
      if (item) return item;
      const group = toolGroupForNextCall();
      item = {id: toolCall.toolCallId, summary: toolCallSummary(toolCall.toolName, toolCall.input), status: 'running', startedAt: Date.now()};
      group.items.push(item);
      startToolTimer();
      updateToolGroup(group, true);
      return item;
    }

    function recordToolStart(toolCall: {toolCallId: string; toolName: string; input: unknown}) {
      callbacks.onEvent?.(agentEvent({type: 'tool_start', id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}));
      ensureToolDisplayItem(toolCall);
      const runningSubagents = activeToolGroup.items.filter(item => item.status === 'running' && item.summary.startsWith('subagent')).length;
      if (runningSubagents > 0) callbacks.setBusyLabel?.(`Running ${runningSubagents} subagent${runningSubagents === 1 ? '' : 's'}`);
    }

    function recordToolDisplayFinish(event: {toolCall: {toolCallId: string; toolName: string; input: unknown}; success: boolean; output?: unknown; error?: unknown; durationMs: number}) {
      callbacks.onEvent?.(agentEvent({type: 'tool_end', id: event.toolCall.toolCallId, name: event.toolCall.toolName, success: event.success, output: event.output, error: event.error, durationMs: event.durationMs}));
      const item = ensureToolDisplayItem(event.toolCall);
      item.startedAt = Math.min(item.startedAt, Date.now() - event.durationMs);
      item.status = toolOutputOk(event.output, event.success) ? 'success' : 'error';
      item.result = toolResultSummary(event);
      item.durationMs = event.durationMs;
      item.finishedAt = item.startedAt + event.durationMs;
      if (typeof event.output === 'object' && event.output != null) {
        const output = event.output as {diff?: unknown; diffLineCount?: unknown; applicableProjectInstructions?: unknown};
        rememberContextFiles(output.applicableProjectInstructions);
        if (typeof output.diffLineCount === 'number') item.diffLineCount = output.diffLineCount;
        if (Array.isArray(output.diff)) item.diff = output.diff as ToolDiffLine[];
      }
      if (event.toolCall.toolName === 'subagent' && typeof event.output === 'object' && event.output != null) {
        const out = event.output as Record<string, unknown>;
        if (Array.isArray(out.toolCalls)) {
          item.subItems = (out.toolCalls as Array<{name: string; summary: string; durationMs: number}>).map(tc => ({
            name: tc.name,
            summary: tc.summary,
            durationMs: tc.durationMs,
          }));
        }
      }
      if (event.toolCall.toolName === 'writeTasks' && event.success) {
        callbacks.onTasksChanged?.();
      }
      const hasRunningTools = activeToolGroup.items.some(candidate => candidate.status === 'running');
      updateToolGroup(activeToolGroup, !assistantSinceActiveToolGroup);
      if (!hasRunningTools) stopToolTimer();
      const runningSubagents = activeToolGroup.items.filter(i => i.status === 'running' && i.summary.startsWith('subagent')).length;
      if (runningSubagents === 0) callbacks.setBusyLabel?.('Haze is thinking');
      else callbacks.setBusyLabel?.(`Running ${runningSubagents} subagent${runningSubagents === 1 ? '' : 's'}`);
    }
    callbacks.debugLog(`request started with ${requestMessages.length} conversation messages; intent=${goal.normalizedIntent}; action=${likelyActionRequest}`);
    function recordToolFinish(event: {toolCall: {toolName: string; input?: unknown}; success: boolean; output?: unknown}) {
      const path = toolInputPath(event.toolCall.input);
      const duplicateSkipped = isDuplicateSkippedOutput(event.output);
      const ok = toolOutputOk(event.output, event.success);
      observeGoalToolEvent(goal, {...event.toolCall, success: ok, output: event.output, duplicateSkipped});
      callbacks.setWorkState?.(goal.workState);
      callbacks.setGoalStatus?.(formatGoalStatus(goal));
      if (!ok && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) {
        editFileFailed = true;
        editRecoveryPath = path;
        editRecoveryReasonCode = typeof event.output === 'object' && event.output != null && 'reasonCode' in event.output && typeof event.output.reasonCode === 'string' ? event.output.reasonCode : undefined;
        editRecoveryReadSatisfied = false;
      }
      if (ok && ['listFiles', 'readFile'].includes(event.toolCall.toolName)) sawReadOnlyTool = true;
      if (ok && event.toolCall.toolName === 'readFile' && path && path === editRecoveryPath && !duplicateSkipped) {
        editRecoveryReadSatisfied = true;
      }
      if (ok && !duplicateSkipped && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) {
        mutatingToolSucceeded = true;
        if (!path || path === editRecoveryPath) {
          editRecoveryPath = undefined;
          editRecoveryReasonCode = undefined;
          editRecoveryReadSatisfied = false;
          editFileFailed = false;
        }
      }
      if (event.success && event.toolCall.toolName === 'bash') {
        if (ok) validationToolSucceeded = true;
        else validationToolFailed = true;
      }
    }

    async function streamAssistantResponse(messages: ModelMessage[], reason: string, prompt: string, allowTools = false) {
      callbacks.debugLog(`requesting assistant ${allowTools ? 'continuation' : 'text'}: ${reason}`);
      const responseId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let responseStarted = false;
      let responseStartedAt = Date.now();
      let responseText = '';
      let continuationToolCalls = 0;
      let followUpStreamError: unknown;
      const prunedMessages = compactToolHistory(stripSyntheticControls(messages)).messages;
      const compactedMessages = estimateValueTokens(prunedMessages) > ACTIVE_CONTEXT_TOKEN_BUDGET
        ? compactModelMessages(prunedMessages, {tokenBudget: ACTIVE_CONTEXT_TOKEN_BUDGET, workState: goal.workState}).messages
        : prunedMessages;
      const continuationMessages = withSyntheticControl(compactedMessages, `${prompt}\n\n${workStatePrompt(goal.workState)}`);
      const followUpSystemPrompt = buildSystemPrompt(activeContextFiles, session);
      const followUpTools = allowTools ? availableTools : undefined;
      const followUpInputBreakdown = estimateInputBreakdown({system: followUpSystemPrompt, contextFiles: activeContextFiles, messages: continuationMessages, tools: followUpTools});
      logEntry(callbacks.log, {at: new Date().toISOString(), type: 'request', stream: `continuation:${reason}`, system: followUpSystemPrompt, messages: continuationMessages, tools: followUpTools ? Object.keys(followUpTools) : [], context: followUpInputBreakdown.breakdown});
      const followUp = streamText({
        model: activeModel,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        system: followUpSystemPrompt,
        messages: continuationMessages,
        ...toolRequestSettings(availableTools, allowTools),
        ...providerSettings,
        stopWhen: stepCountIs(FOLLOW_UP_STEP_LIMIT),
        abortSignal: abortController.signal,
        experimental_context: toolExecutionContext,
        prepareStep({steps, messages}) {
          const toolCalls = steps.flatMap(step => step.toolCalls);
          continuationToolCalls = toolCalls.length;
          const repeatedToolNames = uniqueRepeatedToolNames(toolCalls);
          if (continuationToolCalls >= FOLLOW_UP_TOOL_CALL_LIMIT || toolOnlyStepCount(steps) >= FOLLOW_UP_TOOL_ONLY_STEP_LIMIT) {
            return {
              toolChoice: 'none',
              messages: withSyntheticControl(messages, toolLoopBudgetPrompt()),
            };
          }
          if (repeatedToolNames.length > 0) {
            const activeTools = (Object.keys(availableTools) as Array<keyof typeof availableTools>).filter(name => !repeatedToolNames.includes(name as keyof typeof hazeTools));
            callbacks.debugLog(`disabling repeated tools for follow-up step: ${repeatedToolNames.join(', ')}`);
            return activeTools.length > 0
              ? {activeTools, messages: withSyntheticControl(messages, repeatedToolCallPrompt(repeatedToolNames))}
              : {toolChoice: 'none', messages: withSyntheticControl(messages, repeatedToolCallPrompt(repeatedToolNames))};
          }
          if (likelyPlanOnlyRequest && mutatingToolSucceeded) {
            return {
              toolChoice: 'none',
            };
          }
          if (editRecoveryPath && !editRecoveryReadSatisfied) {
            return {
              activeTools: ['readFile'] as Array<keyof typeof availableTools>,
            };
          }
          return undefined;
        },
        onError({error}) {
          followUpStreamError = error;
          callbacks.debugLog(`stream error: ${error instanceof Error ? error.message : String(error)}`);
        },
        onFinish(event) {
          const providerUsage = extractUsage(event);
          callbacks.recordTokenUsage?.({
            inputTokens: providerUsage.inputTokens,
            outputTokens: providerUsage.outputTokens,
            systemPrompt: followUpInputBreakdown.systemPrompt,
            messages: followUpInputBreakdown.messages,
            toolSchemas: followUpInputBreakdown.toolSchemas,
            outputEstimate: estimateValueTokens(event.response.messages),
            cacheReadTokens: providerUsage.cacheReadTokens,
            cacheWriteTokens: providerUsage.cacheWriteTokens,
            noCacheTokens: providerUsage.noCacheTokens,
            reasoningTokens: providerUsage.reasoningTokens,
            logicalInputEstimate: followUpInputBreakdown.logicalInputEstimate,
            effectiveNonCachedInput: effectiveNonCachedInput(providerUsage.inputTokens, providerUsage.cacheReadTokens),
          });
          const nextConversation = [...stripSyntheticControls(compactedMessages), ...event.response.messages];
          callbacks.setConversation(nextConversation);
          callbacks.debugLog(`conversation updated to ${nextConversation.length} messages after follow-up`);
        },
        experimental_onToolCallStart({toolCall}) {
          sawToolCall = true;
          recordToolStart(toolCall);
          resetIdleTimer();
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_call', stream: `continuation:${reason}`, toolCall: {id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}});
          callbacks.debugLog(`follow-up tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
          const sig = stableToolKey(toolCall);
          const count = (toolCallSignatureCounts.get(sig) ?? 0) + 1;
          toolCallSignatureCounts.set(sig, count);
          if (count >= TOOL_REPETITION_THRESHOLD && !warnedRepeatedToolSignatures.has(sig)) {
            warnedRepeatedToolSignatures.add(sig);
            const preview = sig.length > 100 ? `${sig.slice(0, 100)}…` : sig;
            logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: `continuation:${reason}`, text: `tool repetition guard: "${preview}" called ${count} times with identical input this turn. Steering the model away from this repeated call.`});
            callbacks.debugLog(`tool repetition guard steering (continuation): ${toolCall.toolName} count=${count}`);
          }
        },
        experimental_onToolCallFinish(event) {
          resetIdleTimer();
          recordToolFinish(event);
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: `continuation:${reason}`, toolResult: {id: event.toolCall.toolCallId, name: event.toolCall.toolName, success: event.success, output: event.output, error: event.error, durationMs: event.durationMs}});
          const nestedTokens = subagentTokenEstimate(event.output);
          if (nestedTokens) callbacks.recordTokenUsage?.({inputTokens: nestedTokens.input, outputTokens: nestedTokens.output, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: nestedTokens.input, reasoningTokens: 0, logicalInputEstimate: nestedTokens.input, effectiveNonCachedInput: nestedTokens.input});
          const summary = toolResultSummary(event);
          toolSummaries.push(`${event.toolCall.toolName}: ${summary}`);
          recordToolDisplayFinish(event);
          if (!isDuplicateSkippedOutput(event.output)) toolEpoch += 1;
          callbacks.debugLog(event.success
            ? `follow-up tool done: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.output)}`
            : `follow-up tool error: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.error)}`);
        },
      });
      for await (const rawDelta of followUp.textStream) {
        resetIdleTimer();
        const delta = sanitizeAssistantText(rawDelta);
        responseText += delta;
        const displayText = assistantDisplayText(responseText);
        if ((!shouldStartAssistantStream(displayText, responseStartedAt) || isPrefixOfVisibleAssistantText(displayText)) && !responseStarted) continue;
        if (!responseStarted) {
          responseStarted = true;
          responseStartedAt = Date.now();
          callbacks.onEvent?.(agentEvent({type: 'message_start', id: responseId, role: 'assistant'}));
          const displayedStartedAt = closeToolGroupBeforeAssistantMessage() ?? responseStartedAt;
          callbacks.addMessage({id: responseId, role: 'assistant', text: displayText, streaming: true, startedAt: displayedStartedAt});
        } else {
          callbacks.onEvent?.(agentEvent({type: 'message_update', id: responseId, text: displayText}));
          callbacks.updateMessage(responseId, {text: displayText});
        }
      }
      try {
        await followUp.response;
      } catch (error) {
        throw followUpStreamError ?? error;
      }
      const finalText = assistantDisplayText(responseText);
      const visibleFinalText = finalText;
      const hidden = (responseStarted ? isHiddenAssistantFragment(visibleFinalText) : isHiddenUnstartedFinalText(visibleFinalText)) || isDuplicateVisibleAssistantText(visibleFinalText);
      if (responseStarted) {
        if (!hidden) rememberVisibleAssistantText(visibleFinalText);
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: responseId, text: visibleFinalText, hidden}));
        callbacks.updateMessage(responseId, {text: visibleFinalText, streaming: false, hidden, ...responseCompletionMetrics(visibleFinalText, responseStartedAt)});
      } else if (!hidden) {
        rememberVisibleAssistantText(visibleFinalText);
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: responseId, role: 'assistant'}));
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: responseId, text: visibleFinalText, hidden: false}));
        callbacks.addMessage({id: responseId, role: 'assistant', text: visibleFinalText, streaming: false, startedAt: responseStartedAt, ...responseCompletionMetrics(visibleFinalText, responseStartedAt)});
      }
      return {text: finalText, id: responseId, started: responseStarted};
    }

    let streamError: unknown;
    let lastFinishReason: string | undefined;
    const mainSystemPrompt = buildSystemPrompt(activeContextFiles, session);
    const mainInputBreakdown = estimateInputBreakdown({system: mainSystemPrompt, contextFiles: activeContextFiles, messages: requestMessages, tools: availableTools});
    logEntry(callbacks.log, {at: new Date().toISOString(), type: 'request', stream: 'main', system: mainSystemPrompt, messages: requestMessages, tools: Object.keys(availableTools), context: mainInputBreakdown.breakdown});
    const result = streamText({
      model: activeModel,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      system: mainSystemPrompt,
      messages: requestMessages,
      tools: availableTools,
      ...providerSettings,
      stopWhen: stepCountIs(MAIN_STEP_LIMIT),
      abortSignal: abortController.signal,
      experimental_context: toolExecutionContext,
      onError({error}) {
        streamError = error;
        callbacks.debugLog(`stream error: ${error instanceof Error ? error.message : String(error)}`);
      },
      prepareStep({steps, messages}) {
        const toolCalls = steps.flatMap(step => step.toolCalls);
        const repeatedToolNames = uniqueRepeatedToolNames(toolCalls);
        const repeatedToolCall = repeatedToolNames.length > 0;
        const consecutiveToolOnlySteps = toolOnlyStepCount(steps);

        if (likelyPlanOnlyRequest && mutatingToolSucceeded) {
          return {
            toolChoice: 'none',
          };
        }
        if (editRecoveryPath && !editRecoveryReadSatisfied) {
          return {
            activeTools: ['readFile'] as Array<keyof typeof availableTools>,
          };
        }
        if (repeatedToolCall) {
          const activeTools = (Object.keys(availableTools) as Array<keyof typeof availableTools>).filter(name => !repeatedToolNames.includes(name as keyof typeof hazeTools));
          callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
          return activeTools.length > 0
            ? {activeTools, messages: withSyntheticControl(messages, repeatedToolCallPrompt(repeatedToolNames))}
            : {toolChoice: 'none', messages: withSyntheticControl(messages, repeatedToolCallPrompt(repeatedToolNames))};
        }
        if (toolCalls.length >= MAIN_TOOL_CALL_LIMIT || consecutiveToolOnlySteps >= MAIN_TOOL_ONLY_STEP_LIMIT) {
          callbacks.debugLog('forcing text response to avoid tool loop');
          turnStopReason = toolCalls.length >= MAIN_TOOL_CALL_LIMIT
            ? {kind: 'tool_budget', message: `Reached the per-turn tool-call limit (${MAIN_TOOL_CALL_LIMIT}). Type "continue" to resume — Haze will pick up where it left off.`}
            : {kind: 'tool_only_limit', message: `Made ${MAIN_TOOL_ONLY_STEP_LIMIT} consecutive inspection-only steps without making changes. Type "continue" to resume.`};
          return {
            toolChoice: 'none',
            messages: withSyntheticControl(messages, toolLoopBudgetPrompt()),
          };
        }
        return undefined;
      },
      onStepFinish({stepNumber, text, toolCalls, toolResults, finishReason, usage, response}) {
        for (const toolCall of toolCalls) ensureToolDisplayItem(toolCall);
        if (Array.isArray(response?.messages) && response.messages.length > 0) {
          latestAccumulatedResponseMessages = response.messages as ModelMessage[];
        }
        if (!turnStopReason && stepNumber >= MAIN_STEP_LIMIT - 1) {
          turnStopReason = {kind: 'step_limit', message: `Reached the per-turn step limit (${MAIN_STEP_LIMIT}). Type "continue" to resume — Haze will pick up where it left off.`};
        }
        lastFinishReason = finishReason;
        const stepInputTokens = usage?.inputTokens;
        const stepOutputTokens = usage?.outputTokens;
        const stepCacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        const stepCacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
        const stepReasoning = usage?.outputTokenDetails?.reasoningTokens ?? 0;
        const stepNoCache = effectiveNonCachedInput(stepInputTokens, stepCacheRead) ?? 0;
        const stepCacheHitRatio = cacheHitRatio(stepInputTokens, stepCacheRead || undefined);
        logEntry(callbacks.log, {at: new Date().toISOString(), type: 'step', stream: 'main', step: stepNumber, text, finishReason, usage: {inputTokens: stepInputTokens, outputTokens: stepOutputTokens, cacheReadTokens: stepCacheRead || undefined, cacheWriteTokens: stepCacheWrite || undefined, noCacheTokens: stepNoCache || undefined, reasoningTokens: stepReasoning || undefined, cacheHitRatio: stepCacheHitRatio}});
        if (stepCacheHitRatio !== undefined && stepCacheHitRatio < 0.5 && stepNoCache > 2000) {
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', step: stepNumber, text: `low cache hit: ${(stepCacheHitRatio * 100).toFixed(1)}% (${stepCacheRead}/${stepInputTokens}), ${stepNoCache} no-cache tokens. Likely prompt prefix changed mid-turn.`});
        }
        callbacks.debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}; usage=${stepInputTokens != null ? `in=${stepInputTokens} out=${stepOutputTokens}` : 'not reported'}${stepCacheRead ? ` cached=${stepCacheRead}` : ''}${stepCacheWrite ? ` cache_write=${stepCacheWrite}` : ''}${stepReasoning ? ` reasoning=${stepReasoning}` : ''}${stepCacheHitRatio !== undefined ? ` cache_hit=${(stepCacheHitRatio * 100).toFixed(0)}%` : ''}`);
        // Repetition guard: when a constrained (no-tools) step emits short text
        // that matches the prior two short-text steps, the model is stuck in a
        // "Let me X" loop. Abort the whole turn so we don't burn maxOutputTokens
        // on every remaining step in the limit. The secondary consecutive-text-only
        // check catches varied-phrasing loops (e.g. "Let me install" → "I'll install
        // dependencies now" → "Now let me run npm install") that the exact-signature
        // check would miss.
        if (finishReason === 'stop' && toolCalls.length === 0) {
          consecutiveTextOnlySteps += 1;
          const signature = text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 120);
          if (signature.length >= 8) {
            recentStepTextSignatures.push(signature);
            const last3 = recentStepTextSignatures.slice(-3);
            if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2] && !repetitionAbortFired) {
              repetitionAbortFired = true;
              turnStopReason = {kind: 'text_repetition', message: 'Stopped: the model emitted the same response 3 times in a row (text loop). Type "continue" to try again — the next turn starts fresh.'};
              logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', step: stepNumber, text: `repetition guard: 3 consecutive identical text-only steps. Aborting turn to avoid loop. Last signature: "${signature.slice(0, 60)}"`});
              callbacks.debugLog(`repetition guard abort at step ${stepNumber}; signature="${signature.slice(0, 60)}"`);
              abortController.abort('Haze repetition guard: 3 consecutive identical text-only steps.');
            }
          }
          if (consecutiveTextOnlySteps >= 4 && !repetitionAbortFired) {
            repetitionAbortFired = true;
            turnStopReason = {kind: 'text_repetition', message: 'Stopped: the model emitted several text responses in a row without making progress (likely a varied-phrasing loop). Type "continue" to try again — the next turn starts fresh.'};
            logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', step: stepNumber, text: `repetition guard: ${consecutiveTextOnlySteps} consecutive text-only steps with no tool calls. Aborting turn to avoid varied-phrasing loop.`});
            callbacks.debugLog(`repetition guard abort at step ${stepNumber}; consecutiveTextOnlySteps=${consecutiveTextOnlySteps}`);
            abortController.abort(`Haze repetition guard: ${consecutiveTextOnlySteps} consecutive text-only steps without progress.`);
          }
        } else {
          consecutiveTextOnlySteps = 0;
        }
      },
      onFinish(event) {
        const providerUsage = extractUsage(event);
        callbacks.recordTokenUsage?.({
          inputTokens: providerUsage.inputTokens,
          outputTokens: providerUsage.outputTokens,
          systemPrompt: mainInputBreakdown.systemPrompt,
          messages: mainInputBreakdown.messages,
          toolSchemas: mainInputBreakdown.toolSchemas,
          outputEstimate: estimateValueTokens(event.response.messages),
          cacheReadTokens: providerUsage.cacheReadTokens,
          cacheWriteTokens: providerUsage.cacheWriteTokens,
          noCacheTokens: providerUsage.noCacheTokens,
          reasoningTokens: providerUsage.reasoningTokens,
          logicalInputEstimate: mainInputBreakdown.logicalInputEstimate,
          effectiveNonCachedInput: effectiveNonCachedInput(providerUsage.inputTokens, providerUsage.cacheReadTokens),
        });
        const accumulated = [...stripSyntheticControls(requestMessages), ...event.response.messages];
        const compacted = compactToolHistory(accumulated);
        const nextConversation = compacted.messages;
        callbacks.setConversation(nextConversation);
        if (compacted.compactedResults > 0 || compacted.compactedCalls > 0) {
          callbacks.debugLog(`end-of-turn compaction: ${compacted.compactedResults} results, ${compacted.compactedCalls} tool-call inputs compacted`);
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', text: `end-of-turn compaction: ${compacted.compactedResults} old results, ${compacted.compactedCalls} old tool-call inputs compacted before next turn.`});
        }
        callbacks.debugLog(`conversation updated to ${nextConversation.length} messages`);
      },
      experimental_onToolCallStart({toolCall}) {
        sawToolCall = true;
        recordToolStart(toolCall);
        resetIdleTimer();
        logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_call', stream: 'main', toolCall: {id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}});
        callbacks.debugLog(`tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
        // Tool-repetition guard: if the same (toolName, input) has been called
        // TOOL_REPETITION_THRESHOLD times this turn, log once. prepareStep then
        // disables that repeated tool and injects a model-facing correction.
        const sig = stableToolKey(toolCall);
        const count = (toolCallSignatureCounts.get(sig) ?? 0) + 1;
        toolCallSignatureCounts.set(sig, count);
        if (count >= TOOL_REPETITION_THRESHOLD && !warnedRepeatedToolSignatures.has(sig)) {
          warnedRepeatedToolSignatures.add(sig);
          const preview = sig.length > 100 ? `${sig.slice(0, 100)}…` : sig;
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', text: `tool repetition guard: "${preview}" called ${count} times with identical input this turn. Steering the model away from this repeated call.`});
          callbacks.debugLog(`tool repetition guard steering: ${toolCall.toolName} count=${count} sig=${preview}`);
        }
      },
      experimental_onToolCallFinish(event) {
        resetIdleTimer();
        const summary = toolResultSummary(event);
        recordToolFinish(event);
        logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: event.toolCall.toolCallId, name: event.toolCall.toolName, success: event.success, output: event.output, error: event.error, durationMs: event.durationMs}});
        const nestedTokens = subagentTokenEstimate(event.output);
        if (nestedTokens) callbacks.recordTokenUsage?.({inputTokens: nestedTokens.input, outputTokens: nestedTokens.output, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: nestedTokens.input, reasoningTokens: 0, logicalInputEstimate: nestedTokens.input, effectiveNonCachedInput: nestedTokens.input});
        toolSummaries.push(`${event.toolCall.toolName}: ${summary}`);
        recordToolDisplayFinish(event);
        if (!isDuplicateSkippedOutput(event.output)) toolEpoch += 1;
        callbacks.debugLog(event.success
          ? `tool done: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.output)}`
          : `tool error: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.error)}`);
      }
    });
    for await (const rawDelta of result.textStream) {
      resetIdleTimer();
      const delta = sanitizeAssistantText(rawDelta);
      if (sawToolCall) textAfterTool = true;
      if (currentAssistantStarted && currentAssistantText.length > 0 && toolEpoch > currentAssistantToolEpoch) {
        const intermediateText = assistantDisplayText(currentAssistantText);
        const hidden = isHiddenAssistantFragment(intermediateText) || isDuplicateVisibleAssistantText(intermediateText);
        if (!hidden) rememberVisibleAssistantText(intermediateText);
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: intermediateText, hidden}));
        callbacks.updateMessage(currentAssistantId, {text: intermediateText, streaming: false, hidden, ...responseCompletionMetrics(intermediateText, currentAssistantStartedAt)});
        currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        currentAssistantStarted = false;
        currentAssistantStartedAt = Date.now();
        currentAssistantText = '';
        currentAssistantToolEpoch = toolEpoch;
      }

      assistantText += delta;
      currentAssistantText += delta;
      const displayText = assistantDisplayText(currentAssistantText);
      if ((!shouldStartAssistantStream(displayText, currentAssistantStartedAt) || isPrefixOfVisibleAssistantText(displayText)) && !currentAssistantStarted) continue;
      if (!currentAssistantStarted) {
        assistantStarted = true;
        currentAssistantStarted = true;
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
        currentAssistantStartedAt = Date.now();
        const displayedStartedAt = closeToolGroupBeforeAssistantMessage() ?? currentAssistantStartedAt;
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: displayText, streaming: true, startedAt: displayedStartedAt});
      } else {
        callbacks.onEvent?.(agentEvent({type: 'message_update', id: currentAssistantId, text: displayText}));
        callbacks.updateMessage(currentAssistantId, {text: displayText});
      }
    }
    let completedConversation = callbacks.getConversation();
    try {
      const response = await result.response;
      completedConversation = [...stripSyntheticControls(requestMessages), ...response.messages];
      callbacks.setConversation(completedConversation);
    } catch (error) {
      // The turn was aborted or errored mid-stream. If we have any accumulated
      // response messages from completed steps (tracked in onStepFinish), persist
      // them so the next turn inherits the partial work instead of losing it.
      if (latestAccumulatedResponseMessages.length > 0) {
        const accumulated = [...stripSyntheticControls(requestMessages), ...latestAccumulatedResponseMessages];
        const compacted = compactToolHistory(accumulated);
        callbacks.setConversation(compacted.messages);
        if (compacted.compactedResults > 0 || compacted.compactedCalls > 0) {
          logEntry(callbacks.log, {at: new Date().toISOString(), type: 'warning', stream: 'main', text: `abort recovery: persisted ${latestAccumulatedResponseMessages.length} response messages, compacted ${compacted.compactedResults} results and ${compacted.compactedCalls} tool-call inputs.`});
        }
        callbacks.debugLog(`abort recovery: persisted ${latestAccumulatedResponseMessages.length} response messages before re-throwing`);
      }
      throw streamError ?? error;
    }
    callbacks.debugLog(`response stream finished; session has ${completedConversation.length} model messages`);

    if (lastFinishReason === 'length' && !sawToolCall && completionContinuationCount < maxCompletionContinuations) {
      completionContinuationCount += 1;
      callbacks.debugLog('output token limit reached, auto-continuing');
      const continuation = await streamAssistantResponse(
        completedConversation,
        'output token limit reached',
        'Your response was cut off because you hit the output token limit. Continue from where you left off — do not repeat what you already said, just pick up exactly where you stopped.',
        true,
      );
      completedConversation = callbacks.getConversation();
      if (continuation.text) {
        assistantText += '\n' + continuation.text;
      }
    }
    const combinedAssistantText = assistantDisplayText(assistantText);
    const decideCompletion = (text: string) => completionDecision({
      request: value,
      goal,
      assistantText: text,
      sawReadOnlyTool,
      sawToolCall,
      mutatingToolSucceeded,
      validationToolSucceeded,
      validationToolFailed,
      editFileFailed,
      editRecoveryPath,
      editRecoveryReasonCode,
    });
    let decision = decideCompletion(combinedAssistantText);

    async function runCompletionLoop(seedConversation: ModelMessage[], seedText: string) {
      let loopConversation = seedConversation;
      let latestText = seedText;
      let noProgressSlices = 0;
      while ((decision.needsActionContinuation || decision.needsValidationContinuation) && completionContinuationCount < maxCompletionContinuations) {
        completionContinuationCount += 1;
        const revisionBefore = goal.workState.revision;
        const prompt = decision.continuationPrompt
          ?? (looksIncomplete(latestText) ? postContinuationPrompt() : 'Continue the same user goal until it is complete, blocked by a concrete issue, or needs a user decision. Focus on the concrete blocker, not a generic plan.');
        const continuation = await streamAssistantResponse(loopConversation, `completion gate ${completionContinuationCount}`, prompt, true);
        loopConversation = callbacks.getConversation();
        if (continuation.text) latestText = continuation.text;
        decision = decideCompletion(latestText);
        noProgressSlices = goal.workState.revision === revisionBefore ? noProgressSlices + 1 : 0;
        if (noProgressSlices >= 2) break;
      }
      if ((decision.needsActionContinuation || decision.needsValidationContinuation) && noProgressSlices >= 2) {
        callbacks.addMessage({role: 'assistant', text: 'Status: partial. Two continuation slices made no tool progress; the latest work state and blocker evidence were preserved.'});
      }
      if ((decision.needsActionContinuation || decision.needsValidationContinuation) && completionContinuationCount >= maxCompletionContinuations) {
        callbacks.addMessage({role: 'assistant', text: 'Stopped after the autonomous safety limit. The current goal may still need work; ask me to continue and I will resume from the latest tool results.'});
      }
      if (!latestText && toolSummaries.length > 0) {
        const followUp = await streamAssistantResponse(loopConversation, 'completion loop ended without text', noTextAfterToolPrompt(false), false);
        if (!followUp.text) callbacks.addMessage({role: 'assistant', text: `Finished tool work but the model did not produce a final response. Last tool result: ${toolSummaries.at(-1)}.`});
      }
    }

    if (!assistantStarted) {
      const hidden = isHiddenUnstartedFinalText(combinedAssistantText) || isDuplicateVisibleAssistantText(combinedAssistantText);
      if (!hidden) {
        assistantStarted = true;
        currentAssistantStarted = true;
        currentAssistantText = combinedAssistantText;
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: combinedAssistantText, streaming: true, startedAt: currentAssistantStartedAt});
      }
    }

    if (assistantStarted) {
      const visibleFinalAssistantText = assistantDisplayText(currentAssistantText);
      const hidden = isHiddenAssistantFragment(visibleFinalAssistantText) || isDuplicateVisibleAssistantText(visibleFinalAssistantText);
      if (!hidden) rememberVisibleAssistantText(visibleFinalAssistantText);
      callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: visibleFinalAssistantText, hidden}));
      callbacks.updateMessage(currentAssistantId, {text: visibleFinalAssistantText, streaming: false, hidden, ...responseCompletionMetrics(visibleFinalAssistantText, currentAssistantStartedAt)});
      if (decision.needsActionContinuation || decision.needsValidationContinuation) {
        await runCompletionLoop(completedConversation, combinedAssistantText);
      } else if (sawToolCall && !textAfterTool) {
        const followUp = await streamAssistantResponse(completedConversation, 'tool use completed without follow-up text', noTextAfterToolPrompt(false), false);
        if (!followUp.text) {
          callbacks.addMessage({role: 'assistant', text: 'Stopped after tool use without a follow-up response. You can ask me to continue if the task is not complete.'});
        }
      }
    } else if (sawToolCall) {
      const allowTools = (likelyActionRequest && (!mutatingToolSucceeded || editFileFailed)) || (likelyValidationRequest && !validationToolSucceeded);
      const prompt = noTextAfterToolPrompt(allowTools);
      const followUp = await streamAssistantResponse(completedConversation, 'tool-only turn completed without text', prompt, allowTools);
      decision = decideCompletion(followUp.text);
      if (allowTools) await runCompletionLoop(callbacks.getConversation(), followUp.text);
      if (!followUp.text && completionContinuationCount === 0) {
        const fallback = toolSummaries.length > 0
          ? `Finished tool work but the model did not produce a final response. Last tool result: ${toolSummaries.at(-1)}.`
          : 'Finished without a text response.';
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: fallback, streaming: false, startedAt: currentAssistantStartedAt, ...responseCompletionMetrics(fallback, currentAssistantStartedAt)});
      }
    } else {
      const fallback = 'Finished without a text response.';
      callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: fallback, streaming: false, startedAt: currentAssistantStartedAt, ...responseCompletionMetrics(fallback, currentAssistantStartedAt)});
    }
    goal.phase = 'done';
    goal.status = 'complete';
    turnStatus = 'complete';
    if (turnStopReason) {
      callbacks.addMessage({role: 'system', text: turnStopReason.message});
    }
    callbacks.setGoalStatus?.(undefined);
  } catch (error) {
    if (abortController.signal.aborted) {
      turnStatus = 'aborted';
      callbacks.debugLog('request aborted');
      callbacks.addMessage({role: 'system', text: turnStopReason?.message ?? 'Thinking aborted. You can type again.'});
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
    if (idleTimer) clearTimeout(idleTimer);
    finalizeToolGroup();
    stopActiveTimers();
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status: turnStatus}));
    callbacks.setAbortController?.(null);
    callbacks.setBusy(false);
  }
}
