import {stepCountIs, streamText, type ModelMessage} from 'ai';
import {model} from '../../llm/client.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {buildSystemPrompt} from '../../llm/systemPrompt.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {buildSkillTools} from '../../skills/skillTools.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {compact, toolCallSummary, toolResultSummary, formatSeconds} from './formatters.js';

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

function isPlanOnlyRequest(value: string) {
  return /\b(create|make|write|draft|outline)\s+(?:a\s+)?plan\b|\bplan\s+(?:for|to)\b/i.test(value) && !/\bimplement|execute|do\b/i.test(value);
}

function isLikelyActionRequest(value: string) {
  if (isPlanOnlyRequest(value)) return false;
  return /\b(add|create|write|implement|update|fix|change|support|wire|test|tests|document|docs|documentation|run|verify)\b/i.test(value);
}

function isValidationRequest(value: string) {
  if (isPlanOnlyRequest(value)) return false;
  return /\b(run|verify|test|tests|check|validate)\b/i.test(value);
}

function isPlanImplementationRequest(value: string) {
  return /\b(implement|execute|do)\b.*\bplan\b|\bplan\.md\b|\btest_plan\.md\b/i.test(value);
}

function looksIncomplete(text: string) {
  return /\b(incomplete|what remains|remains:|next:|not implemented|not created|no tests exist|created no docs|has not been|have not been|not yet|never executed|not executed|not run|cannot retry|cannot write|cannot validate|tool budget reached)\b/i.test(text);
}

function sanitizeAssistantText(text: string) {
  return [...text].filter(char => {
    const code = char.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 || code === 155);
  }).join('');
}

function toolInputPath(input: unknown) {
  return typeof input === 'object' && input != null && 'path' in input && typeof (input as {path?: unknown}).path === 'string'
    ? (input as {path: string}).path
    : undefined;
}

function isDuplicateSkippedOutput(output: unknown) {
  return typeof output === 'object' && output != null && 'duplicateSkipped' in output && (output as {duplicateSkipped?: unknown}).duplicateSkipped === true;
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
}

export async function runAgentTurn(
  value: string,
  displayValue: string | undefined,
  contextFiles: ContextFile[],
  callbacks: StreamCallbacks,
): Promise<void> {
  const displayVal = displayValue ?? value;
  const userMessage: Message = {role: 'user', text: displayVal};
  callbacks.setBusy(true);
  callbacks.addMessage(userMessage);
  const abortController = new AbortController();
  callbacks.setAbortController?.(abortController);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortController.abort('Haze turn timed out after no model/tool activity.'), 90_000);
  };

  try {
    const m = await model();
    if (!m) {
      callbacks.addMessage({role: 'assistant', text: 'No API key configured. Run /login, then /model x-ai/grok-build-0.1. Haze cannot hallucinate without credentials. Progress.'});
      return;
    }
    const activeModel = m;
    const skillRegistry = await loadSkillRegistry();
    const availableTools = {...hazeTools, ...buildSkillTools(skillRegistry)};
    const likelyPlanOnlyRequest = isPlanOnlyRequest(value);
    const likelyPlanImplementationRequest = isPlanImplementationRequest(value);
    const likelyActionRequest = isLikelyActionRequest(value);
    const likelyValidationRequest = isValidationRequest(value);
    const planImplementationGuidance = 'When implementing a plan file, first identify the concrete required checklist items and compare them with the current files. Do not edit source or tests when the required behavior is already present. Implement the smallest clearly required phase or required items, skip optional/design-question items unless explicitly requested, add tests rather than exploratory one-off scripts where possible, use file tools (not bash) for any file changes, run validation once after code/test edits, then update plan status with file tools if requested. Do not call unresolved optional scope a blocker.';
    const requestMessages: ModelMessage[] = likelyPlanImplementationRequest
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
    let sawReadOnlyTool = false;
    let sawToolCall = false;
    let textAfterTool = false;
    let forcedContinuationUsed = false;
    let secondContinuationUsed = false;
    let editRecoveryPath: string | undefined;
    let editRecoveryReadSatisfied = false;
    const toolSummaries: string[] = [];
    const toolExecutionContext = {inFlightToolCalls: new Map<string, Promise<unknown>>()};
    const toolGroupId = `tools-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toolDisplayItems: Array<{id: string; summary: string; status: 'running' | 'success' | 'error'; result?: string; durationMs?: number; hidden?: boolean}> = [];
    let toolGroupStarted = false;

    function renderToolGroup(streaming: boolean) {
      const visibleItems = toolDisplayItems.filter(item => !item.hidden);
      const grouped = new Map<string, {item: typeof visibleItems[number]; count: number}>();
      for (const item of visibleItems) {
        const key = `${item.status}:${item.summary}:${item.result ?? ''}`;
        const current = grouped.get(key);
        if (current) current.count += 1;
        else grouped.set(key, {item, count: 1});
      }
      const rows = [...grouped.values()];
      const running = visibleItems.some(item => item.status === 'running');
      const header = running || streaming ? 'Running tools' : `Tools: ${visibleItems.length} call${visibleItems.length === 1 ? '' : 's'}`;
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
      toolDisplayItems.push({id: toolCall.toolCallId, summary: toolCallSummary(toolCall.toolName, toolCall.input), status: 'running'});
      updateToolGroup(true);
    }

    function recordToolDisplayFinish(event: {toolCall: {toolCallId: string; toolName: string; input: unknown}; success: boolean; output?: unknown; error?: unknown; durationMs: number}) {
      const item = toolDisplayItems.find(candidate => candidate.id === event.toolCall.toolCallId);
      if (!item) return;
      item.status = event.success ? 'success' : 'error';
      item.result = toolResultSummary(event);
      item.durationMs = event.durationMs;
      item.hidden = isDuplicateSkippedOutput(event.output);
      updateToolGroup(toolDisplayItems.some(candidate => candidate.status === 'running'));
    }
    callbacks.debugLog(`request started with ${requestMessages.length} conversation messages; action=${likelyActionRequest}`);
    function recordToolFinish(event: {toolCall: {toolName: string; input?: unknown}; success: boolean; output?: unknown}) {
      const path = toolInputPath(event.toolCall.input);
      const duplicateSkipped = isDuplicateSkippedOutput(event.output);
      if (!event.success && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) {
        editFileFailed = true;
        editRecoveryPath = path;
        editRecoveryReadSatisfied = false;
      }
      if (event.success && ['listFiles', 'readFile'].includes(event.toolCall.toolName)) sawReadOnlyTool = true;
      if (event.success && event.toolCall.toolName === 'readFile' && path && path === editRecoveryPath && !duplicateSkipped) {
        editRecoveryReadSatisfied = true;
      }
      if (event.success && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) {
        mutatingToolSucceeded = true;
        if (!path || path === editRecoveryPath) {
          editRecoveryPath = undefined;
          editRecoveryReadSatisfied = false;
          editFileFailed = false;
        }
      }
      if (event.success && event.toolCall.toolName === 'bash') {
        const ok = typeof event.output === 'object' && event.output != null && 'ok' in event.output ? Boolean((event.output as {ok?: unknown}).ok) : true;
        if (ok) validationToolSucceeded = true;
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
                {role: 'user' as const, content: 'Tool budget reached. If the current request is complete, summarize only current-turn changes and validation. If incomplete, state the concrete blocker briefly; do not claim tools are unavailable and do not recap unrelated earlier tasks.'},
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
        if (!responseStarted) {
          responseStarted = true;
          callbacks.addMessage({id: responseId, role: 'assistant', text: delta, streaming: true});
        } else {
          callbacks.updateMessage(responseId, {text: responseText});
        }
      }
      if (responseStarted) {
        callbacks.setLastAssistantText(responseText.trim());
        callbacks.updateMessage(responseId, {streaming: false});
      }
      return responseText.trim();
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
              {role: 'user' as const, content: 'Tool budget reached. If the current request is complete, summarize only current-turn changes and validation. If the requested change is incomplete, state the concrete blocker briefly. Do not claim tools are unavailable, recap unrelated earlier tasks, or provide a generic remains list.'},
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
        callbacks.updateMessage(currentAssistantId, {streaming: false});
        currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        currentAssistantText = '';
        currentAssistantToolEpoch = toolEpoch;
      }

      assistantText += delta;
      currentAssistantText += delta;
      if (currentAssistantText === delta) {
        assistantStarted = true;
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: currentAssistantText, streaming: true});
      } else {
        callbacks.updateMessage(currentAssistantId, {text: currentAssistantText});
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
    const finalAssistantText = assistantText.trim();
    const assistantAdmitsIncomplete = looksIncomplete(finalAssistantText);
    const requestCompletedByTools = mutatingToolSucceeded && validationToolSucceeded && !editRecoveryPath;
    const needsActionContinuation = likelyActionRequest
      && !requestCompletedByTools
      && ((sawReadOnlyTool && !mutatingToolSucceeded) || editFileFailed || assistantAdmitsIncomplete);
    const needsValidationContinuation = likelyValidationRequest && !requestCompletedByTools && !validationToolSucceeded && (sawReadOnlyTool || mutatingToolSucceeded || assistantAdmitsIncomplete);

    if (assistantStarted) {
      callbacks.setLastAssistantText(finalAssistantText);
      callbacks.updateMessage(currentAssistantId, {streaming: false});
      if ((needsActionContinuation || needsValidationContinuation) && !forcedContinuationUsed) {
        forcedContinuationUsed = true;
        callbacks.updateMessage(currentAssistantId, {text: 'Continuing to complete the requested change...', streaming: false});
        const prompt = editFileFailed
          ? 'Your editFile attempt failed. Use the latest readFile line-numbered output and replaceLines to complete the requested change. Continue with any remaining tests or validation if relevant. Do not stop with a summary.'
          : needsValidationContinuation
            ? 'You have not run the requested validation yet. Continue now by running the appropriate test/check command. Summarize only after the command finishes.'
            : mutatingToolSucceeded
              ? 'Your previous response says the current request is incomplete. Continue now with the remaining edits and validation for this same request. Do not summarize a plan unless blocked.'
              : 'You inspected files but have not made the requested change yet. Continue now by editing or writing the necessary files. Do not summarize a plan unless blocked.';
        const continuationText = await streamAssistantResponse(completedConversation, 'current-turn completion gate', prompt, true);
        if (!secondContinuationUsed && looksIncomplete(continuationText) && (likelyActionRequest || likelyValidationRequest)) {
          secondContinuationUsed = true;
          await streamAssistantResponse(callbacks.getConversation(), 'post-continuation completion gate', 'Your previous response still described unfinished work, missing validation, or a tool-budget issue. If any tools are still available, complete the remaining edit or run the final validation now. Only call something a blocker if a concrete tool failure prevents progress.', true);
        }
      } else if (sawToolCall && !textAfterTool) {
        const followUpText = await streamAssistantResponse(completedConversation, 'tool use completed without follow-up text', 'Continue from the tool result and answer my original request. Do not call tools. Summarize only current-turn changes and validation; do not recap unrelated earlier tasks.', false);
        if (!followUpText) {
          callbacks.addMessage({role: 'assistant', text: 'Stopped after tool use without a follow-up response. You can ask me to continue if the task is not complete.'});
        }
      }
    } else if (sawToolCall) {
      const allowTools = (likelyActionRequest && (!mutatingToolSucceeded || editFileFailed)) || (likelyValidationRequest && !validationToolSucceeded);
      const prompt = allowTools
        ? 'Continue the original request now. If it asks for a change, edit or write the necessary files. If it asks to run or verify tests, run the command. Do not provide only a retrospective summary unless blocked.'
        : 'Continue from the tool result and answer my original request. Do not call tools. Summarize only current-turn changes and validation; do not recap unrelated earlier tasks.';
      const followUpText = await streamAssistantResponse(completedConversation, 'tool-only turn completed without text', prompt, allowTools);
      if (!secondContinuationUsed && allowTools && looksIncomplete(followUpText)) {
        secondContinuationUsed = true;
        await streamAssistantResponse(callbacks.getConversation(), 'post-follow-up completion gate', 'Your previous response still described unfinished work, missing validation, or a tool-budget issue. If any tools are still available, complete the remaining edit or run the final validation now. Only call something a blocker if a concrete tool failure prevents progress.', true);
      }
      if (!followUpText) {
        const fallback = toolSummaries.length > 0
          ? `Finished tool work but the model did not produce a final response. Last tool result: ${toolSummaries.at(-1)}.`
          : 'Finished without a text response.';
        callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: fallback, streaming: false});
      }
    } else {
      callbacks.addMessage({id: currentAssistantId, role: 'assistant', text: 'Finished without a text response.', streaming: false});
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      callbacks.debugLog('request aborted');
      callbacks.addMessage({role: 'system', text: 'Thinking aborted. You can type again.'});
    } else {
      const text = error instanceof Error ? error.message : String(error);
      callbacks.debugLog(`error: ${text}`);
      callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    callbacks.setAbortController?.(null);
    callbacks.setBusy(false);
  }
}
