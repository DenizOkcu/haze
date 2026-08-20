import {agentEvent} from '../../../core/agent/events.js';
import {formatGoalStatus, observeGoalToolEvent, type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {DEFAULT_TOOL_DEADLINE_MS, SUBAGENT_TOOL_DEADLINE_MS, isToolBudgetBlocked} from '../../../core/agent/budgets.js';
import {isToolDeadlineExceeded} from '../../../core/deadline.js';
import {isDuplicateSkippedOutput, safeToolFailureDetails, toolOutputOk} from '../../../core/agent/toolResults.js';
import {toolResultSummary} from '../formatters.js';
import {toolDiffFromResult, type NativeToolCall, type ToolGroupRenderer} from './toolGroupRenderer.js';
import {isMalformedToolInputError} from './toolCallRecovery.js';
import {logEntry, rememberContextFilesFromToolOutput, subagentTokenEstimate} from './turnRuntime.js';
import type {StreamCallbacks} from '../streaming.js';
import type {AttemptSetup} from './attemptSetup.js';
import type {AttemptLoopState} from './streamLoop.js';

/**
 * Tool stream-part handlers (extracted from streamLoop.ts): apply one finished
 * tool call — success, error, budget-blocked, or deadline-exceeded — to the
 * tool display, events/log, goal observation, and loop state.
 */

type NativeToolFinish = {toolCall: NativeToolCall; success: boolean; output?: unknown; error?: unknown; durationMs: number};

/** One consumed public stream part, keyed by `type` (see the AI SDK's full-stream parts). */
export type AttemptStreamPart = {type: string} & Record<string, unknown>;

type ToolPartHandlerDeps = {
  loopState: AttemptLoopState;
  callbacks: StreamCallbacks;
  toolDisplay: ToolGroupRenderer;
  setup: AttemptSetup;
  goal: SessionGoal;
};

export function handleToolResultPart(deps: ToolPartHandlerDeps, part: AttemptStreamPart) {
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

export function handleToolErrorPart(deps: ToolPartHandlerDeps, part: AttemptStreamPart) {
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
