import {stepCountIs, streamText, type ModelMessage} from 'ai';
import {model} from '../../llm/client.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {buildSystemPrompt} from '../../llm/systemPrompt.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {buildSkillTools} from '../../skills/skillTools.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {compact, toolCallSummary, toolResultSummary, formatSeconds} from './formatters.js';
import {isActionRequest, isPlanImplementationRequest, isPlanOnlyRequest, isValidationRequest} from '../../core/goal/requestClassifier.js';
import {completionDecision, looksIncomplete, noTextAfterToolPrompt, postContinuationPrompt, toolLoopBudgetPrompt} from '../../core/goal/completionPolicy.js';
import {createSessionGoal, formatGoalStatus, observeGoalToolEvent} from '../../core/goal/sessionGoal.js';
import {agentEvent, type AgentEventSink} from '../../core/agent/events.js';
import {isContextOverflowError, isRetryableModelError} from '../../core/agent/errors.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean; hidden?: boolean};

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

function toolOutputOk(output: unknown, success: boolean) {
  if (!success) return false;
  return !(typeof output === 'object' && output != null && 'ok' in output && (output as {ok?: unknown}).ok === false);
}

export interface StreamCallbacks {
  addMessage: (msg: Message) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  setConversation: (messages: ModelMessage[]) => void;
  setBusy: (busy: boolean) => void;
  debugLog: (line: string) => void;
  getConversation: () => ModelMessage[];
  getLastAssistantText: () => string;
  setLastAssistantText: (text: string) => void;
  setAbortController?: (controller: AbortController | null) => void;
  setGoalStatus?: (status: string | undefined) => void;
  onEvent?: AgentEventSink;
  compactConversation?: (instructions?: string) => boolean;
}

export async function runAgentTurn(
  value: string,
  displayValue: string | undefined,
  contextFiles: ContextFile[],
  callbacks: StreamCallbacks,
  retryAttempt = 0,
  retryingExistingRequest = false,
  contextOverflowRecovered = false,
): Promise<void> {
  const displayVal = displayValue ?? value;
  const userMessage: Message = {role: 'user', text: displayVal};
  callbacks.onEvent?.(agentEvent({type: 'turn_start', request: value}));
  callbacks.setBusy(true);
  if (!retryingExistingRequest) callbacks.addMessage(userMessage);
  const abortController = new AbortController();
  callbacks.setAbortController?.(abortController);
  let turnStatus: 'complete' | 'aborted' | 'failed' = 'failed';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortController.abort('Haze turn timed out after no model/tool activity.'), 90_000);
  };

  try {
    const m = await model();
    if (!m) {
      callbacks.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. Haze cannot hallucinate without a model. Progress.'});
      return;
    }
    const activeModel = m;
    const skillRegistry = await loadSkillRegistry();
    const availableTools = {...hazeTools, ...buildSkillTools(skillRegistry)};
    const goal = createSessionGoal(value);
    callbacks.setGoalStatus?.(formatGoalStatus(goal));
    const likelyPlanOnlyRequest = isPlanOnlyRequest(value);
    const likelyPlanImplementationRequest = isPlanImplementationRequest(value);
    const likelyActionRequest = isActionRequest(value);
    const likelyValidationRequest = isValidationRequest(value);
    const planImplementationGuidance = 'When implementing a plan file, first identify the concrete required checklist items and compare them with the current files. Do not edit source or tests when the required behavior is already present. Implement the smallest clearly required phase or required items, skip optional/design-question items unless explicitly requested, add tests rather than exploratory one-off scripts where possible, use file tools (not bash) for any file changes, run validation once after code/test edits, then update plan status with file tools if requested. Do not call unresolved optional scope a blocker.';
    const requestMessages: ModelMessage[] = retryingExistingRequest
      ? callbacks.getConversation()
      : likelyPlanImplementationRequest
        ? [...callbacks.getConversation(), {role: 'user', content: value}, {role: 'user', content: planImplementationGuidance}]
        : [...callbacks.getConversation(), {role: 'user', content: value}];
    callbacks.setConversation(requestMessages);
    resetIdleTimer();
    let currentAssistantId = `assistant-${Date.now()}`;
    let assistantStarted = false;
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
    const maxCompletionContinuations = 4;
    let editRecoveryPath: string | undefined;
    let editRecoveryReadSatisfied = false;
    const toolSummaries: string[] = [];
    const toolExecutionContext = {inFlightToolCalls: new Map<string, Promise<unknown>>()};
    const toolGroupId = `tools-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toolDisplayItems: Array<{id: string; summary: string; status: 'running' | 'success' | 'error'; result?: string; durationMs?: number; hidden?: boolean}> = [];
    let toolGroupStarted = false;

    function renderToolGroup(streaming: boolean) {
      const visibleItems = toolDisplayItems.filter(item => !item.hidden);
      const running = visibleItems.some(item => item.status === 'running');
      const failures = visibleItems.filter(item => item.status === 'error');
      const changes = visibleItems.filter(item => /^(editFile|replaceLines|writeFile)\b/.test(item.summary));
      const compactItems = !running && visibleItems.length > 12
        ? [...new Map([...failures, ...changes].map(item => [item.id, item])).values()]
        : visibleItems;
      const grouped = new Map<string, {item: typeof compactItems[number]; count: number}>();
      for (const item of compactItems) {
        const key = `${item.status}:${item.summary}:${item.result ?? ''}`;
        const current = grouped.get(key);
        if (current) current.count += 1;
        else grouped.set(key, {item, count: 1});
      }
      const rows = [...grouped.values()];
      const compactSuffix = !running && visibleItems.length > 12 ? ` · showing ${compactItems.length} important` : '';
      const header = running || streaming
        ? 'Running tools'
        : `Tools: ${visibleItems.length} call${visibleItems.length === 1 ? '' : 's'} · ${changes.length} change${changes.length === 1 ? '' : 's'} · ${failures.length} failed${compactSuffix}`;
      const lines = rows.map(({item, count}) => {
        const icon = item.status === 'running' ? '…' : item.status === 'success' ? '✓' : '✗';
        const countText = count > 1 ? ` ×${count}` : '';
        const result = item.status === 'running' ? '' : ` — ${item.result ?? item.status}${item.durationMs == null ? '' : ` in ${formatSeconds(item.durationMs)}`}`;
        return `  ${icon} ${item.summary}${countText}${result}`;
      });
      return [header, ...lines].join('\n');
    }

    function updateToolGroup(streaming = true) {
      const text = renderToolGroup(streaming);
      if (!toolGroupStarted) {
        toolGroupStarted = true;
        callbacks.addMessage({id: toolGroupId, role: 'tool', text, streaming});
      } else {
        callbacks.updateMessage(toolGroupId, {text, streaming});
      }
    }

    function recordToolStart(toolCall: {toolCallId: string; toolName: string; input: unknown}) {
      callbacks.onEvent?.(agentEvent({type: 'tool_start', id: toolCall.toolCallId, name: toolCall.toolName, input: toolCall.input}));
      toolDisplayItems.push({id: toolCall.toolCallId, summary: toolCallSummary(toolCall.toolName, toolCall.input), status: 'running'});
      updateToolGroup(true);
    }

    function recordToolDisplayFinish(event: {toolCall: {toolCallId: string; toolName: string; input: unknown}; success: boolean; output?: unknown; error?: unknown; durationMs: number}) {
      callbacks.onEvent?.(agentEvent({type: 'tool_end', id: event.toolCall.toolCallId, name: event.toolCall.toolName, success: event.success, output: event.output, error: event.error, durationMs: event.durationMs}));
      const item = toolDisplayItems.find(candidate => candidate.id === event.toolCall.toolCallId);
      if (!item) return;
      item.status = toolOutputOk(event.output, event.success) ? 'success' : 'error';
      item.result = toolResultSummary(event);
      item.durationMs = event.durationMs;
      item.hidden = isDuplicateSkippedOutput(event.output);
      updateToolGroup(toolDisplayItems.some(candidate => candidate.status === 'running'));
    }
    callbacks.debugLog(`request started with ${requestMessages.length} conversation messages; intent=${goal.normalizedIntent}; action=${likelyActionRequest}`);
    function recordToolFinish(event: {toolCall: {toolName: string; input?: unknown}; success: boolean; output?: unknown}) {
      const path = toolInputPath(event.toolCall.input);
      const duplicateSkipped = isDuplicateSkippedOutput(event.output);
      const ok = toolOutputOk(event.output, event.success);
      observeGoalToolEvent(goal, {...event.toolCall, success: ok, output: event.output, duplicateSkipped});
      callbacks.setGoalStatus?.(formatGoalStatus(goal));
      if (!ok && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) {
        editFileFailed = true;
        editRecoveryPath = path;
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
      let responseText = '';
      let continuationToolCalls = 0;
      const continuationMessages: ModelMessage[] = [
        ...messages,
        {role: 'user', content: prompt},
      ];
      const followUp = streamText({
        model: activeModel,
        temperature: 0,
        system: buildSystemPrompt(contextFiles),
        messages: continuationMessages,
        tools: availableTools,
        toolChoice: allowTools ? 'auto' : 'none',
        stopWhen: stepCountIs(10),
        abortSignal: abortController.signal,
        experimental_context: toolExecutionContext,
        prepareStep({steps, messages}) {
          continuationToolCalls = steps.flatMap(step => step.toolCalls).length;
          if (continuationToolCalls >= 10 || toolOnlyStepCount(steps) >= 5) {
            return {
              toolChoice: 'none',
              messages: [
                ...messages,
                {role: 'user' as const, content: toolLoopBudgetPrompt()},
              ],
            };
          }
          if (likelyPlanOnlyRequest && mutatingToolSucceeded) {
            return {
              toolChoice: 'none',
              messages: [
                ...messages,
                {role: 'user' as const, content: 'This was a planning request and the plan artifact has been created or updated. Stop using tools and summarize the plan file only; do not implement or validate it.'},
              ],
            };
          }
          if (editRecoveryPath && !editRecoveryReadSatisfied) {
            return {
              activeTools: ['readFile'] as Array<keyof typeof availableTools>,
              messages: [
                ...messages,
                {role: 'user' as const, content: `A previous edit failed for ${editRecoveryPath}. Before any further edit or bash inspection, call readFile on exactly ${editRecoveryPath}. Bash/cat does not satisfy this recovery step.`},
              ],
            };
          }
          if (editFileFailed) return {activeTools: ['listFiles', 'readFile', 'replaceLines', 'writeFile', 'bash'] as Array<keyof typeof availableTools>};
          return undefined;
        },
        onError({error}) {
          callbacks.debugLog(`stream error: ${error instanceof Error ? error.message : String(error)}`);
        },
        onFinish(event) {
          callbacks.setConversation([...continuationMessages, ...event.response.messages]);
          callbacks.debugLog(`conversation updated to ${continuationMessages.length + event.response.messages.length} messages after follow-up`);
        },
        experimental_onToolCallStart({toolCall}) {
          sawToolCall = true;
          recordToolStart(toolCall);
          resetIdleTimer();
          callbacks.debugLog(`follow-up tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
        },
        experimental_onToolCallFinish(event) {
          resetIdleTimer();
          recordToolFinish(event);
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
        const displayText = hideSyntheticToolCallMarkup(responseText);
        if (!displayText && !responseStarted) continue;
        if (!responseStarted) {
          responseStarted = true;
          callbacks.onEvent?.(agentEvent({type: 'message_start', id: responseId, role: 'assistant'}));
          callbacks.addMessage({id: responseId, role: 'assistant', text: displayText, streaming: true});
        } else {
          callbacks.onEvent?.(agentEvent({type: 'message_update', id: responseId, text: displayText}));
          callbacks.updateMessage(responseId, {text: displayText});
        }
      }
      const finalText = hideSyntheticToolCallMarkup(responseText).trim();
      if (responseStarted) {
        callbacks.setLastAssistantText(finalText);
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: responseId, text: finalText, hidden: finalText.length === 0}));
        callbacks.updateMessage(responseId, {text: finalText, streaming: false, hidden: finalText.length === 0});
      }
      return {text: finalText, id: responseId, started: responseStarted};
    }

    const result = streamText({
      model: activeModel,
      temperature: 0,
      system: buildSystemPrompt(contextFiles),
      messages: requestMessages,
      tools: availableTools,
      stopWhen: stepCountIs(12),
      abortSignal: abortController.signal,
      experimental_context: toolExecutionContext,
      onError({error}) {
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
            messages: [
              ...messages,
              {role: 'user' as const, content: 'This was a planning request and the plan artifact has been created or updated. Stop using tools and summarize the plan file only; do not implement or validate it.'},
            ],
          };
        }
        if (editRecoveryPath && !editRecoveryReadSatisfied) {
          return {
            activeTools: ['readFile'] as Array<keyof typeof availableTools>,
            messages: [
              ...messages,
              {role: 'user' as const, content: `A previous edit failed for ${editRecoveryPath}. Before any further edit or bash inspection, call readFile on exactly ${editRecoveryPath}. Bash/cat does not satisfy this recovery step.`},
            ],
          };
        }
        if (repeatedToolCall) {
          const activeTools = (Object.keys(availableTools) as Array<keyof typeof availableTools>).filter(name => !repeatedToolNames.includes(name as keyof typeof hazeTools));
          callbacks.debugLog(`disabling repeated tools for next step: ${repeatedToolNames.join(', ')}`);
          return {
            activeTools,
            messages: [
              ...messages,
              {role: 'user' as const, content: `You already called ${repeatedToolNames.join(', ')} with the same input. Do not repeat that tool call. Use a different relevant tool. If this is an action request and no file change has been made yet, continue with edit/write tools rather than summarizing.`},
            ],
          };
        }
        if (likelyActionRequest && !mutatingToolSucceeded && consecutiveToolOnlySteps >= 3 && toolCalls.length < 10) {
          callbacks.debugLog('nudging action request toward mutation after read-only steps');
          return {
            messages: [
              ...messages,
              {role: 'user' as const, content: 'You have inspected enough for now. This is an action request; make the requested change with editFile, replaceLines, or writeFile instead of saying tools are unavailable or summarizing.'},
            ],
          };
        }
        if (toolCalls.length >= 12 || consecutiveToolOnlySteps >= 5) {
          callbacks.debugLog('forcing text response to avoid tool loop');
          return {
            toolChoice: 'none',
            messages: [
              ...messages,
              {role: 'user' as const, content: toolLoopBudgetPrompt()},
            ],
          };
        }
        if (editFileFailed) return {activeTools: ['listFiles', 'readFile', 'replaceLines', 'writeFile', 'bash'] as Array<keyof typeof availableTools>};
        return undefined;
      },
      onStepFinish({stepNumber, text, toolCalls, toolResults, finishReason}) {
        callbacks.debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
      },
      onFinish(event) {
        const nextConversation = [...requestMessages, ...event.response.messages];
        callbacks.setConversation(nextConversation);
        callbacks.debugLog(`conversation updated to ${nextConversation.length} messages`);
      },
      experimental_onToolCallStart({toolCall}) {
        sawToolCall = true;
        recordToolStart(toolCall);
        resetIdleTimer();
        callbacks.debugLog(`tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
      },
      experimental_onToolCallFinish(event) {
        resetIdleTimer();
        const summary = toolResultSummary(event);
        recordToolFinish(event);
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
      if (currentAssistantText.length > 0 && toolEpoch > currentAssistantToolEpoch) {
        callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: hideSyntheticToolCallMarkup(currentAssistantText).trim()}));
        callbacks.updateMessage(currentAssistantId, {streaming: false});
        currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        currentAssistantText = '';
        currentAssistantToolEpoch = toolEpoch;
      }

      assistantText += delta;
      currentAssistantText += delta;
      const displayText = hideSyntheticToolCallMarkup(currentAssistantText);
      if (!displayText && !assistantStarted) continue;
      if (!assistantStarted) {
        assistantStarted = true;
        callbacks.onEvent?.(agentEvent({type: 'message_start', id: currentAssistantId, role: 'assistant'}));
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: displayText, streaming: true});
      } else {
        callbacks.onEvent?.(agentEvent({type: 'message_update', id: currentAssistantId, text: displayText}));
        callbacks.updateMessage(currentAssistantId, {text: displayText});
      }
    }
    let completedConversation = callbacks.getConversation();
    try {
      const response = await result.response;
      completedConversation = [...requestMessages, ...response.messages];
      callbacks.setConversation(completedConversation);
    } catch {
      // Keep the conversation from onFinish if the response promise is unavailable.
    }
    callbacks.debugLog(`response stream finished; session has ${completedConversation.length} model messages`);
    const finalAssistantText = hideSyntheticToolCallMarkup(assistantText).trim();
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
    });
    let decision = decideCompletion(finalAssistantText);

    async function runCompletionLoop(seedConversation: ModelMessage[], seedText: string) {
      let loopConversation = seedConversation;
      let latestText = seedText;
      while ((decision.needsActionContinuation || decision.needsValidationContinuation) && completionContinuationCount < maxCompletionContinuations) {
        completionContinuationCount += 1;
        const prompt = decision.continuationPrompt
          ?? (looksIncomplete(latestText) ? postContinuationPrompt() : 'Continue the same user goal until it is complete, blocked by a concrete issue, or needs a user decision. Focus on the concrete blocker, not a generic plan.');
        const continuation = await streamAssistantResponse(loopConversation, `completion gate ${completionContinuationCount}`, prompt, true);
        loopConversation = callbacks.getConversation();
        if (continuation.text) latestText = continuation.text;
        decision = decideCompletion(latestText);
        if (continuation.started && (decision.needsActionContinuation || decision.needsValidationContinuation)) {
          callbacks.updateMessage(continuation.id, {hidden: true});
        }
      }
      if ((decision.needsActionContinuation || decision.needsValidationContinuation) && completionContinuationCount >= maxCompletionContinuations) {
        callbacks.addMessage({role: 'assistant', text: 'Stopped after the bounded completion loop. The current goal may still need work; ask me to continue and I will resume from the latest tool results.'});
      }
      if (!latestText && toolSummaries.length > 0) {
        const followUp = await streamAssistantResponse(loopConversation, 'completion loop ended without text', noTextAfterToolPrompt(false), false);
        if (!followUp.text) callbacks.addMessage({role: 'assistant', text: `Finished tool work but the model did not produce a final response. Last tool result: ${toolSummaries.at(-1)}.`});
      }
    }

    if (assistantStarted) {
      const hidePreToolFragment = sawToolCall && !textAfterTool;
      callbacks.setLastAssistantText(hidePreToolFragment ? '' : finalAssistantText);
      callbacks.onEvent?.(agentEvent({type: 'message_end', id: currentAssistantId, text: finalAssistantText, hidden: finalAssistantText.length === 0 || hidePreToolFragment}));
      callbacks.updateMessage(currentAssistantId, {text: finalAssistantText, streaming: false, hidden: finalAssistantText.length === 0 || hidePreToolFragment});
      if (decision.needsActionContinuation || decision.needsValidationContinuation) {
        callbacks.updateMessage(currentAssistantId, {streaming: false, hidden: true});
        await runCompletionLoop(completedConversation, finalAssistantText);
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
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: fallback, streaming: false});
      }
    } else {
      callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: 'Finished without a text response.', streaming: false});
    }
    goal.phase = 'done';
    goal.status = 'complete';
    turnStatus = 'complete';
    callbacks.setGoalStatus?.(formatGoalStatus(goal));
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
          await runAgentTurn(value, displayValue, contextFiles, callbacks, retryAttempt, true, true);
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
        await runAgentTurn(value, displayValue, contextFiles, callbacks, retryAttempt + 1, true, contextOverflowRecovered);
        return;
      }
      callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    callbacks.onEvent?.(agentEvent({type: 'turn_end', request: value, status: turnStatus}));
    callbacks.setAbortController?.(null);
    callbacks.setBusy(false);
  }
}
