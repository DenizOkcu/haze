import {ToolLoopAgent, isStepCount, type ModelMessage} from 'ai';
import {agentEvent} from '../../../core/agent/events.js';
import {malformedToolCallPrompt, repeatedToolCallPrompt, toolLoopBudgetPrompt, formatGoalStatus, observeGoalToolEvent, type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {estimateMessagesTokens, estimateValueTokens} from '../../../core/agent/contextBudget.js';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl} from '../../../core/agent/requestAssembly.js';
import {compactModelMessages} from '../../../core/agent/compaction.js';
import {latestRepeatedToolNames, toolOnlyStepCount} from '../../../core/agent/turnPolicy.js';
import {RESCUE_BOUNDARY, type TurnExecutionState} from '../../../core/agent/completionController.js';
import {MAIN_TOOL_CALL_LIMIT, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TOOL_DEADLINE_MS, SUBAGENT_TOOL_DEADLINE_MS, WRITE_FILE_CHUNK_BYTES, isToolBudgetBlocked, type ToolExecutionBudgetState, type TurnBudget} from '../../../core/agent/budgets.js';
import {isToolDeadlineExceeded} from '../../../core/deadline.js';
import {isDuplicateSkippedOutput, safeToolFailureDetails, toolOutputOk} from '../../../core/agent/toolResults.js';
import {projectContextSection} from '../../../llm/systemPrompt.js';
import {toolsContextFor, type HazeToolContext} from '../../../llm/tools/toolContext.js';
import {busyToolLabel, toolCallSummary, toolResultSummary} from '../formatters.js';
import type {StreamCallbacks, TurnExecutionOptions} from '../streaming.js';
import {sanitizeAssistantText, assistantDisplayText, normalizeAssistantText, shouldStartAssistantStream, isHiddenAssistantFragment, isHiddenUnstartedFinalText, isShortLeadInBeforeTool, isShortUnfinishedLeadIn} from './assistantText.js';
import {toolDiffFromResult, type NativeToolCall, type ToolGroupRenderer} from './toolGroupRenderer.js';
import {applyStepToolResultState, initialToolResultState, type ToolResultState} from './toolResultState.js';
import {clampOutOfBoundsToolNumbers, isMalformedToolInputError} from './toolCallRecovery.js';
import {extractUsage, logEntry, rememberContextFilesFromToolOutput, responseCompletionMetrics, stepCacheMetrics, subagentTokenEstimate} from './turnRuntime.js';
import type {AttemptSalvage, StreamStallGuard} from './stallRecovery.js';
import type {AttemptSetup} from './attemptSetup.js';
import type {ContextFile} from '../../../config/contextFiles.js';

type NativeToolFinish = {toolCall: NativeToolCall; success: boolean; output?: unknown; error?: unknown; durationMs: number};

/** One consumed public stream part, keyed by `type` (see the AI SDK's full-stream parts). */
type AttemptStreamPart = {type: string} & Record<string, unknown>;

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

function withScopedContextControl(messages: ModelMessage[], context: HazeToolContext): ModelMessage[] {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return withSyntheticControl(
    messages,
    `Additional scoped project instructions were just read for a non-root path touched by a tool call. Apply them to subsequent work in that subtree.${projectContextSection(files)}`,
  );
}

type AgentOptions = NonNullable<ConstructorParameters<typeof ToolLoopAgent>[0]>;
type RepairToolCallFn = NonNullable<AgentOptions['experimental_repairToolCall']>;
type PrepareStepFn = NonNullable<AgentOptions['prepareStep']>;

function createRepairToolCall(deps: AttemptStreamDeps): RepairToolCallFn {
  const {callbacks, loopState} = deps;
  return async ({toolCall, error, inputSchema}) => {
    if (isMalformedToolInputError(error)) {
      const clamped = await clampOutOfBoundsToolNumbers(toolCall.input, toolCall.toolName, inputSchema);
      if (clamped != null) {
        callbacks.debugLog(`clamped out-of-range numeric input for ${toolCall.toolName}; executing repaired call`);
        return {type: 'tool-call' as const, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: JSON.stringify(clamped)};
      }
      loopState.pendingMalformedToolName = toolCall.toolName;
      loopState.unresolvedMalformedToolName = toolCall.toolName;
    }
    // Truncated generated file content cannot be reconstructed safely here;
    // let the next agent step retry under the bounded tool-choice constraint.
    return null;
  };
}

function createPrepareStep(deps: AttemptStreamDeps): PrepareStepFn {
  const {setup, callbacks, loopState, turnState, turnBudget, goal, recoverySlice} = deps;
  const {sliceTools, requestBudget, toolExecutionContext, likelyPlanOnlyRequest, rescueWithoutTools} = setup;
  return ({steps, messages}) => {
    // A rescue slice with no qualifying tools must synthesize, never reopen
    // discovery by falling back to the full tool set (F-08).
    if (rescueWithoutTools) {
      callbacks.debugLog('rescue slice has no mutation/validation tools; forcing tool-free synthesis');
      return {toolChoice: 'none' as const};
    }
    const toolCalls = steps.flatMap(step => step.toolCalls);
    const repeatedToolNames = latestRepeatedToolNames(steps);
    let scopedMessages = withScopedContextControl(messages, toolExecutionContext);
    let messagesChanged = scopedMessages !== messages;
    // Re-evaluate the accumulated request size before each provider call and
    // compact old tool history when it exceeds the model-aware budget, so a
    // long multi-step turn compacts before overflowing (RH-005).
    if (estimateMessagesTokens(scopedMessages) > requestBudget.messageTokens) {
      const compacted = compactModelMessages(stripSyntheticControls(scopedMessages), {tokenBudget: requestBudget.messageTokens, workState: goal}).messages;
      scopedMessages = compacted;
      messagesChanged = true;
    }
    // Turn-wide hard caps (shared across retries and recovery slices).
    const turnToolCallsExhausted = turnState.toolCallsUsed >= turnBudget.toolCallLimit;
    // Per-slice tool-call cap for a recovery slice (counts this slice's calls).
    const sliceToolCallsExhausted = recoverySlice ? toolCalls.length >= recoverySlice.maxToolCalls : false;
    // Reserve the final tool-only slot for rescue: normal exploration stops at
    // the boundary; a rescue slice is exempt so it may use the reserved slot.
    const toolOnlyBoundaryHit = !recoverySlice && toolOnlyStepCount(steps) >= RESCUE_BOUNDARY;
    if (likelyPlanOnlyRequest && loopState.toolResultState.mutatingToolSucceeded) return messagesChanged ? {toolChoice: 'none' as const, messages: scopedMessages} : {toolChoice: 'none' as const};
    if (loopState.pendingMalformedToolName && loopState.pendingMalformedToolName in sliceTools) {
      const toolName = loopState.pendingMalformedToolName as keyof typeof sliceTools;
      const attempt = loopState.malformedRecoveryAttempts.get(String(toolName)) ?? 0;
      loopState.pendingMalformedToolName = undefined;
      if (attempt >= 2) {
        callbacks.debugLog(`malformed ${String(toolName)} recovery exhausted`);
        return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, `The ${String(toolName)} input remained invalid after two smaller retries. Report this as blocked; do not promise another retry or claim completion.`)};
      }
      loopState.malformedRecoveryAttempts.set(String(toolName), attempt + 1);
      callbacks.debugLog(`forcing smaller retry after malformed ${String(toolName)} input`);
      // OpenAI-compatible servers differ in tool_choice support: several
      // (LM Studio, llama.cpp) accept only the string form (none/auto/
      // required) and reject the object form with HTTP 400. Narrowing to a
      // single active tool plus 'required' preserves the forced-call
      // semantics on every server.
      return {activeTools: [toolName] as Array<keyof typeof sliceTools>, toolChoice: 'required' as const, messages: withSyntheticControl(scopedMessages, malformedToolCallPrompt(String(toolName), WRITE_FILE_CHUNK_BYTES))};
    }
    if (loopState.toolResultState.editRecoveryPath && !loopState.toolResultState.editRecoveryReadSatisfied) {
      if ('readFile' in sliceTools) return messagesChanged ? {activeTools: ['readFile'] as Array<keyof typeof sliceTools>, messages: scopedMessages} : {activeTools: ['readFile'] as Array<keyof typeof sliceTools>};
      return {toolChoice: 'none' as const, messages: withSyntheticControl(scopedMessages, `The failed mutation of ${loopState.toolResultState.editRecoveryPath} requires a fresh read, but readFile is unavailable in this bounded recovery slice. Report the unfinished edit as blocked; do not claim it succeeded.`)};
    }
    if (repeatedToolNames.length > 0) {
      const activeTools = (Object.keys(sliceTools) as Array<keyof typeof sliceTools>).filter(name => !repeatedToolNames.includes(name as string));
      callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
      return activeTools.length > 0
        ? {activeTools, messages: withSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))}
        : {toolChoice: 'none', messages: withSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))};
    }
    if (turnToolCallsExhausted || sliceToolCallsExhausted || toolOnlyBoundaryHit || toolCalls.length >= MAIN_TOOL_CALL_LIMIT) {
      callbacks.debugLog('forcing text response to avoid tool loop');
      return {toolChoice: 'none', messages: withSyntheticControl(scopedMessages, toolLoopBudgetPrompt())};
    }
    return messagesChanged ? {messages: scopedMessages} : undefined;
  };
}

function resetAssistantSegment(loopState: AttemptLoopState) {
  loopState.currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  loopState.assistantStarted = false;
  loopState.assistantStartedAt = Date.now();
  loopState.currentAssistantText = '';
}

function finalizeAssistantSegment(loopState: AttemptLoopState, callbacks: StreamCallbacks, options: {beforeTool?: boolean} = {}) {
  const finalText = assistantDisplayText(loopState.currentAssistantText);
  const normalized = normalizeAssistantText(finalText);
  const hidden = (loopState.assistantStarted ? isHiddenAssistantFragment(finalText) : isHiddenUnstartedFinalText(finalText))
    || (options.beforeTool === true && isShortLeadInBeforeTool(finalText))
    || (options.beforeTool !== true && isShortUnfinishedLeadIn(finalText))
    || (normalized.length > 0 && loopState.visibleAssistantTexts.has(normalized));
  if (loopState.assistantStarted) {
    if (!hidden) loopState.rememberVisibleAssistantText(finalText);
    callbacks.onEvent?.(agentEvent({type: 'message_end', id: loopState.currentAssistantId, text: finalText, hidden}));
    callbacks.updateMessage(loopState.currentAssistantId, {text: finalText, streaming: false, hidden, ...responseCompletionMetrics(finalText, loopState.assistantStartedAt)});
  } else if (!hidden) {
    if (!hidden) loopState.rememberVisibleAssistantText(finalText);
    callbacks.onEvent?.(agentEvent({type: 'message_start', id: loopState.currentAssistantId, role: 'assistant'}));
    callbacks.onEvent?.(agentEvent({type: 'message_end', id: loopState.currentAssistantId, text: finalText, hidden: false}));
    callbacks.addMessage({id: loopState.currentAssistantId, role: 'assistant', text: finalText, streaming: false, startedAt: loopState.assistantStartedAt, ...responseCompletionMetrics(finalText, loopState.assistantStartedAt)});
  }
  resetAssistantSegment(loopState);
  return !hidden;
}

function finalizePendingAssistantBeforeTool(deps: AttemptStreamDeps) {
  const {loopState, callbacks, toolDisplay} = deps;
  if (loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted) {
    const pending = assistantDisplayText(loopState.currentAssistantText);
    const shown = finalizeAssistantSegment(loopState, callbacks, {beforeTool: true});
    if (!shown && pending) toolDisplay.setGroupCaption(pending);
  }
}

function handleToolResultPart(deps: AttemptStreamDeps, part: AttemptStreamPart) {
  const {loopState, callbacks, toolDisplay, setup, goal} = deps;
  const toolCallId = part.toolCallId as string;
  const toolName = part.toolName as string;
  const toolCall = {toolCallId, toolName, input: part.input};
  loopState.latestToolCalls.set(toolCallId, toolCall);
  loopState.inFlightTools.delete(toolCallId);
  const startedAt = loopState.startedTools.get(toolCallId) ?? Date.now();
  // A budget-blocked call never reached the underlying implementation;
  // record it as a bounded non-event with no goal/observal side effect (RH-003).
  if (isToolBudgetBlocked(part.output)) {
    const item = toolDisplay.ensureToolItem(toolCall);
    item.status = 'error';
    item.result = 'skipped: tool-call budget exhausted';
    item.durationMs = Date.now() - startedAt;
    item.finishedAt = startedAt + (item.durationMs ?? 0);
    callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, errorCode: 'tool_budget_blocked', durationMs: item.durationMs ?? 0}));
    toolDisplay.updateToolGroup(true);
    return;
  }
  // A deadline-exceeded call was terminated at the wrapper boundary; the
  // underlying work may still be settling and must not mutate goal state (RH-004).
  if (isToolDeadlineExceeded(part.output)) {
    const item = toolDisplay.ensureToolItem(toolCall);
    item.status = 'error';
    item.result = `timed out after ${DEFAULT_TOOL_DEADLINE_MS}ms`;
    const durationMs = Date.now() - startedAt;
    item.durationMs = durationMs;
    item.finishedAt = startedAt + durationMs;
    callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, errorCode: 'tool_deadline', durationMs}));
    callbacks.onEvent?.(agentEvent({type: 'timeout', phase: 'tool', timeoutMs: toolName === 'subagent' ? SUBAGENT_TOOL_DEADLINE_MS : DEFAULT_TOOL_DEADLINE_MS}));
    toolDisplay.updateToolGroup(true);
    return;
  }
  const ok = toolOutputOk(part.output, true);
  loopState.lastToolOk = ok;
  if (ok && part.toolName === loopState.unresolvedMalformedToolName) loopState.unresolvedMalformedToolName = undefined;
  const finish: NativeToolFinish = {toolCall, success: ok, output: part.output, durationMs: Date.now() - startedAt};
  const item = toolDisplay.ensureToolItem(toolCall);
  item.status = ok ? 'success' : 'error';
  item.result = toolResultSummary(finish);
  item.diff = toolDiffFromResult(toolCall, part.output);
  item.durationMs = finish.durationMs;
  item.finishedAt = startedAt + finish.durationMs;
  const failureDetails = ok || setup.toolCategories.get(toolCall.toolName) !== 'builtin' ? {} : safeToolFailureDetails(part.output);
  callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: ok, output: part.output, ...failureDetails, durationMs: finish.durationMs}));
  logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: ok, output: part.output, durationMs: finish.durationMs}});
  observeGoalToolEvent(goal, {...toolCall, success: ok, output: part.output, duplicateSkipped: isDuplicateSkippedOutput(part.output)});
  callbacks.setWorkState?.(goal);
  callbacks.setGoalStatus?.(formatGoalStatus(goal));
  loopState.contextFiles = rememberContextFilesFromToolOutput(loopState.contextFiles, part.output);
  if (toolCall.toolName === 'writeTasks') callbacks.onTasksChanged?.();
  const nestedTokens = subagentTokenEstimate(part.output);
  if (nestedTokens) callbacks.recordTokenUsage?.({inputTokens: nestedTokens.input, outputTokens: nestedTokens.output, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: nestedTokens.input, reasoningTokens: 0, logicalInputEstimate: nestedTokens.input, effectiveNonCachedInput: nestedTokens.input});
  toolDisplay.updateToolGroup(true);
}

function handleToolErrorPart(deps: AttemptStreamDeps, part: AttemptStreamPart) {
  const {loopState, callbacks, toolDisplay, setup, goal} = deps;
  const toolCallId = part.toolCallId as string;
  const toolName = part.toolName as string;
  loopState.inFlightTools.delete(toolCallId);
  const existing = loopState.latestToolCalls.get(toolCallId);
  const toolCall = {toolCallId, toolName, input: part.input ?? existing?.input};
  const startedAt = loopState.startedTools.get(toolCallId) ?? Date.now();
  loopState.lastToolOk = false;
  if (isMalformedToolInputError(part.error)) {
    loopState.pendingMalformedToolName = toolName;
    loopState.unresolvedMalformedToolName = toolName;
  }
  const finish: NativeToolFinish = {toolCall, success: false, error: part.error, durationMs: Date.now() - startedAt};
  const item = toolDisplay.ensureToolItem(toolCall);
  item.status = 'error';
  item.result = toolResultSummary(finish);
  item.durationMs = finish.durationMs;
  item.finishedAt = startedAt + finish.durationMs;
  const publicError = setup.toolCategories.get(toolCall.toolName) === 'builtin' ? {error: part.error} : {};
  callbacks.onEvent?.(agentEvent({type: 'tool_end', id: toolCall.toolCallId, name: toolCall.toolName, success: false, errorCode: 'tool_execution_error', ...publicError, durationMs: finish.durationMs}));
  logEntry(callbacks.log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: toolCall.toolCallId, name: toolCall.toolName, success: false, error: part.error, durationMs: finish.durationMs}});
  observeGoalToolEvent(goal, {...toolCall, success: false, output: part.error});
  callbacks.setWorkState?.(goal);
  callbacks.setGoalStatus?.(formatGoalStatus(goal));
  toolDisplay.updateToolGroup(true);
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
      callbacks.onEvent?.(agentEvent({type: 'step_end', attempt: retryAttempt + 1, step: stepNumber + 1, finishReason, toolCallCount: toolCalls.length, usage: publicUsage}));
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
