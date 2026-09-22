import type {ModelMessage} from 'ai';
import {agentEvent} from '../../../core/agent/events.js';
import {editRecoveryReadPrompt, malformedToolCallPrompt, repeatedToolCallPrompt, toolLoopBudgetPrompt, type SessionGoal} from '../../../core/agent/goalPolicy.js';
import {estimateConversationTokens, type ContextUsageAnchor} from '../../../core/agent/contextBudget.js';
import {compactModelMessages} from '../../../core/agent/compaction.js';
import {appendSyntheticControl, stripSyntheticControls} from '../../../core/agent/requestAssembly.js';
import {latestRepeatedToolNames, toolOnlyStepCount} from '../../../core/agent/turnPolicy.js';
import {RESCUE_BOUNDARY} from '../../../core/agent/completionController.js';
import {MAIN_TOOL_CALL_LIMIT, WRITE_FILE_CHUNK_BYTES} from '../../../core/agent/budgets.js';
import {projectContextSection} from '../../../llm/systemPrompt.js';
import type {HazeToolContext} from '../../../llm/tools/toolContext.js';
import type {StreamCallbacks, TurnExecutionOptions} from '../streaming.js';
import {clampOutOfBoundsToolNumbers, isMalformedToolInputError} from './toolCallRecovery.js';
import type {AttemptSetup} from './attemptSetup.js';
import type {AttemptLoopState} from './streamLoop.js';
import type {TurnExecutionState} from '../../../core/agent/completionController.js';

/**
 * The per-step request preparation decision tree (extracted from
 * streamLoop.ts): scoped context injection, mid-turn compaction, and the
 * ordered model-constraint guards (rescue synthesis, plan-only finals,
 * malformed-tool retries, edit recovery, repeated-tool suppression, budget
 * exhaustion). Each guard returns the step's tool-choice/messages override or
 * falls through to the default request.
 */

type AgentOptions = NonNullable<ConstructorParameters<typeof import('ai').ToolLoopAgent>[0]>;
type RepairToolCallFn = NonNullable<AgentOptions['experimental_repairToolCall']>;
type PrepareStepFn = NonNullable<AgentOptions['prepareStep']>;
type SyncPrepareStepResult = Exclude<ReturnType<PrepareStepFn>, PromiseLike<unknown>>;

export function withScopedContextControl(messages: ModelMessage[], context: HazeToolContext): ModelMessage[] {
  const files = context.pendingContextFiles ?? [];
  if (files.length === 0) return messages;
  context.pendingContextFiles = [];
  return appendSyntheticControl(
    messages,
    `Additional scoped project instructions were just read for a non-root path touched by a tool call. Apply them to subsequent work in that subtree.${projectContextSection(files)}`,
  );
}

export function createRepairToolCall(deps: {callbacks: StreamCallbacks; loopState: AttemptLoopState}): RepairToolCallFn {
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

export function createPrepareStep(deps: {setup: AttemptSetup; callbacks: StreamCallbacks; loopState: AttemptLoopState; turnState: TurnExecutionState; turnBudget: {toolCallLimit: number}; goal: SessionGoal; recoverySlice: TurnExecutionOptions['recoverySlice']; usageAnchor: {current: ContextUsageAnchor | undefined}}): (input: Parameters<PrepareStepFn>[0]) => SyncPrepareStepResult {
  const {setup, callbacks, loopState, turnState, turnBudget, goal, recoverySlice, usageAnchor} = deps;
  const {sliceTools, requestBudget, toolExecutionContext, likelyPlanOnlyRequest, rescueWithoutTools} = setup;
  return ({steps, messages}: Parameters<PrepareStepFn>[0]): SyncPrepareStepResult => {
    // A rescue slice with no qualifying tools must synthesize, never reopen
    // discovery by falling back to the full tool set (F-08).
    if (rescueWithoutTools) {
      callbacks.debugLog('rescue slice has no mutation/validation tools; forcing tool-free synthesis');
      return {toolChoice: 'none' as const};
    }
    const toolCalls = steps.flatMap(step => step.toolCalls);
    // ToolLoopAgent instances are intentionally one step wide. SDK `steps`
    // therefore resets at each resource epoch; retain only bounded policy
    // metadata in loopState instead of holding prior StepResult graphs.
    const repeatedToolNames = steps.length > 0 ? latestRepeatedToolNames(steps) : loopState.latestRepeatedToolNames;
    let scopedMessages = withScopedContextControl(messages, toolExecutionContext);
    let messagesChanged = scopedMessages !== messages;
    // Re-evaluate the accumulated request size before each provider call and
    // compact old tool history when it exceeds the model-aware budget, so a
    // long multi-step turn compacts before overflowing (RH-005). The estimate
    // prefers provider usage from the last completed step (Pillar 1.1); this
    // sync path is the safety net under the epoch-boundary LLM compaction.
    const contextEstimate = estimateConversationTokens(scopedMessages, usageAnchor.current, requestBudget.systemTokens + requestBudget.toolSchemaTokens);
    if (contextEstimate.tokens > requestBudget.messageTokens) {
      callbacks.onEvent?.(agentEvent({type: 'compaction_start', reason: 'threshold', method: 'heuristic'}));
      const compacted = compactModelMessages(stripSyntheticControls(scopedMessages), {tokenBudget: requestBudget.messageTokens, workState: goal});
      if (compacted.compacted) {
        scopedMessages = compacted.messages;
        loopState.contextCompactedInEpoch = true;
        messagesChanged = true;
        usageAnchor.current = undefined;
        callbacks.recordCompaction?.({method: 'heuristic', olderCount: compacted.olderCount, keptCount: compacted.keptCount, summary: compacted.summary ?? ''});
      }
      callbacks.onEvent?.(agentEvent({type: 'compaction_end', reason: 'threshold', method: compacted.compacted ? 'heuristic' : 'none', compacted: compacted.compacted, olderCount: compacted.olderCount, keptCount: compacted.keptCount}));
    }
    // Turn-wide hard caps (shared across retries and recovery slices).
    const turnToolCallsExhausted = turnState.toolCallsUsed >= turnBudget.toolCallLimit;
    // Per-slice tool-call cap for a recovery slice (counts this slice's calls).
    const sliceToolCalls = steps.length > 0 ? toolCalls.length : loopState.generatedToolCalls;
    const sliceToolCallsExhausted = recoverySlice ? sliceToolCalls >= recoverySlice.maxToolCalls : false;
    // Reserve the final tool-only slot for rescue: normal exploration stops at
    // the boundary; a rescue slice is exempt so it may use the reserved slot.
    const consecutiveToolOnlySteps = steps.length > 0 ? toolOnlyStepCount(steps) : loopState.consecutiveToolOnlySteps;
    const toolOnlyBoundaryHit = !recoverySlice && consecutiveToolOnlySteps >= RESCUE_BOUNDARY;
    if (likelyPlanOnlyRequest && loopState.toolResultState.mutatingToolSucceeded) return messagesChanged ? {toolChoice: 'none' as const, messages: scopedMessages} : {toolChoice: 'none' as const};
    if (loopState.pendingMalformedToolName && loopState.pendingMalformedToolName in sliceTools) {
      const toolName = loopState.pendingMalformedToolName as keyof typeof sliceTools;
      const attempt = loopState.malformedRecoveryAttempts.get(String(toolName)) ?? 0;
      loopState.pendingMalformedToolName = undefined;
      if (attempt >= 2) {
        callbacks.debugLog(`malformed ${String(toolName)} recovery exhausted`);
        return {toolChoice: 'none' as const, messages: appendSyntheticControl(scopedMessages, `The ${String(toolName)} input remained invalid after two smaller retries. Report this as blocked; do not promise another retry or claim completion.`)};
      }
      loopState.malformedRecoveryAttempts.set(String(toolName), attempt + 1);
      callbacks.debugLog(`forcing smaller retry after malformed ${String(toolName)} input`);
      // OpenAI-compatible servers differ in tool_choice support: several
      // (LM Studio, llama.cpp) accept only the string form (none/auto/
      // required) and reject the object form with HTTP 400. Narrowing to a
      // single active tool plus 'required' preserves the forced-call
      // semantics on every server.
      return {activeTools: [toolName] as Array<keyof typeof sliceTools>, toolChoice: 'required' as const, messages: appendSyntheticControl(scopedMessages, malformedToolCallPrompt(String(toolName), WRITE_FILE_CHUNK_BYTES))};
    }
    if (loopState.toolResultState.editRecoveryPath && !loopState.toolResultState.editRecoveryReadSatisfied) {
      // Instruct, do not restrict: the execution-time gate in toolContext
      // (failed-mutation path requires a fresh read) is the structural
      // enforcer and returns a recoverable structured error. Narrowing the
      // request tool set here would downgrade that to a step-fatal
      // AI_NoSuchToolError when a model retries the edit anyway.
      if ('readFile' in sliceTools) return {messages: appendSyntheticControl(scopedMessages, editRecoveryReadPrompt(loopState.toolResultState.editRecoveryPath))};
      return {toolChoice: 'none' as const, messages: appendSyntheticControl(scopedMessages, `The failed mutation of ${loopState.toolResultState.editRecoveryPath} requires a fresh read, but readFile is unavailable in this bounded recovery slice. Report the unfinished edit as blocked; do not claim it succeeded.`)};
    }
    if (repeatedToolNames.length > 0) {
      const activeTools = (Object.keys(sliceTools) as Array<keyof typeof sliceTools>).filter(name => !repeatedToolNames.includes(name as string));
      callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
      return activeTools.length > 0
        ? {activeTools, messages: appendSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))}
        : {toolChoice: 'none', messages: appendSyntheticControl(scopedMessages, repeatedToolCallPrompt(repeatedToolNames))};
    }
    if (turnToolCallsExhausted || sliceToolCallsExhausted || toolOnlyBoundaryHit || sliceToolCalls >= MAIN_TOOL_CALL_LIMIT) {
      callbacks.debugLog('forcing text response to avoid tool loop');
      return {toolChoice: 'none', messages: appendSyntheticControl(scopedMessages, toolLoopBudgetPrompt())};
    }
    return messagesChanged ? {messages: scopedMessages} : undefined;
  };
}
