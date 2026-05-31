import {stepCountIs, streamText, type ModelMessage} from 'ai';
import {model} from '../../llm/client.js';
import {hazeTools} from '../../llm/hazeTools.js';
import {buildSystemPrompt} from '../../llm/systemPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {compact, toolCallSummary, toolOutputDetails, toolResultSummary, formatSeconds} from './formatters.js';

export type Message = {id?: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; streaming?: boolean};

function stableToolKey(toolCall: {toolName: string; input: unknown}) {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.input)}`;
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

  try {
    const m = await model();
    if (!m) {
      callbacks.addMessage({role: 'assistant', text: 'No model configured. Run /login, then /model <model-name>. Haze cannot hallucinate without credentials. Progress.'});
      return;
    }
    const activeModel = m;
    const requestMessages: ModelMessage[] = [...callbacks.getConversation(), {role: 'user', content: value}];
    callbacks.setConversation(requestMessages);
    const assistantId = `assistant-${Date.now()}`;
    let assistantStarted = false;
    let assistantText = '';
    let editFileFailed = false;
    let mutatingToolSucceeded = false;
    let sawToolCall = false;
    let textAfterTool = false;
    const toolSummaries: string[] = [];
    callbacks.debugLog(`request started with ${requestMessages.length} conversation messages`);
    async function streamAssistantResponse(messages: ModelMessage[], reason: string) {
      callbacks.debugLog(`requesting assistant text: ${reason}`);
      const responseId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let responseStarted = false;
      let responseText = '';
      const continuationMessages: ModelMessage[] = [
        ...messages,
        {role: 'user', content: 'Continue from the tool result and answer my original request. Do not call tools.'},
      ];
      const followUp = streamText({
        model: activeModel,
        system: buildSystemPrompt(contextFiles),
        messages: continuationMessages,
        tools: hazeTools,
        toolChoice: 'none',
        onFinish({response}) {
          callbacks.setConversation([...continuationMessages, ...response.messages]);
          callbacks.debugLog(`conversation updated to ${continuationMessages.length + response.messages.length} messages after follow-up`);
        },
      });
      for await (const delta of followUp.textStream) {
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
      system: buildSystemPrompt(contextFiles),
      messages: requestMessages,
      tools: hazeTools,
      stopWhen: stepCountIs(12),
      prepareStep({steps}) {
        const toolCalls = steps.flatMap(step => step.toolCalls);
        const consecutiveToolOnlySteps = [...steps].reverse().findIndex(step => step.toolCalls.length === 0 || step.text.trim().length > 0);
        const toolKeys = new Set<string>();
        const repeatedToolCall = toolCalls.some(toolCall => {
          const key = stableToolKey(toolCall);
          if (toolKeys.has(key)) return true;
          toolKeys.add(key);
          return false;
        });

        if (mutatingToolSucceeded || toolCalls.length >= 8 || consecutiveToolOnlySteps >= 3 || repeatedToolCall) {
          callbacks.debugLog('forcing text response to avoid tool loop');
          return {toolChoice: 'none'};
        }
        if (editFileFailed) return {activeTools: ['listFiles', 'readFile', 'replaceLines', 'writeFile', 'bash'] as Array<keyof typeof hazeTools>};
        return undefined;
      },
      onStepFinish({stepNumber, text, toolCalls, toolResults, finishReason}) {
        callbacks.debugLog(`step ${stepNumber} finished: ${finishReason}; text=${text.length}; toolCalls=${toolCalls.length}; toolResults=${toolResults.length}`);
      },
      onFinish({response}) {
        const nextConversation = [...requestMessages, ...response.messages];
        callbacks.setConversation(nextConversation);
        callbacks.debugLog(`conversation updated to ${nextConversation.length} messages`);
      },
      experimental_onToolCallStart({toolCall}) {
        sawToolCall = true;
        const text = toolCallSummary(toolCall.toolName, toolCall.input);
        callbacks.addMessage({id: `tool-${toolCall.toolCallId}`, role: 'tool', text, streaming: true});
        callbacks.debugLog(`tool start: ${toolCall.toolName} ${compact(toolCall.input)}`);
      },
      experimental_onToolCallFinish(event) {
        const summary = toolResultSummary(event);
        const details = event.toolCall.toolName === 'bash' && event.success ? toolOutputDetails(event.output) : '';
        const text = `${toolCallSummary(event.toolCall.toolName, event.toolCall.input)}\n${event.success ? '✓' : '✗'} ${summary} in ${formatSeconds(event.durationMs)}${details ? `\n\n${details}` : ''}`;
        if (!event.success && event.toolCall.toolName === 'editFile') editFileFailed = true;
        if (event.success && ['editFile', 'replaceLines', 'writeFile'].includes(event.toolCall.toolName)) mutatingToolSucceeded = true;
        toolSummaries.push(`${event.toolCall.toolName}: ${summary}`);
        callbacks.updateMessage(`tool-${event.toolCall.toolCallId}`, {text, streaming: false});
        callbacks.debugLog(event.success
          ? `tool done: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.output)}`
          : `tool error: ${event.toolCall.toolName} after ${event.durationMs}ms ${compact(event.error)}`);
      }
    });
    for await (const delta of result.textStream) {
      if (sawToolCall) textAfterTool = true;
      assistantText += delta;
      if (!assistantStarted) {
        assistantStarted = true;
        callbacks.addMessage({id: assistantId, role: 'assistant', text: delta, streaming: true});
      } else {
        callbacks.updateMessage(assistantId, {text: assistantText});
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
    if (assistantStarted) {
      callbacks.setLastAssistantText(assistantText.trim());
      callbacks.updateMessage(assistantId, {streaming: false});
      if (sawToolCall && !textAfterTool) {
        const followUpText = await streamAssistantResponse(completedConversation, 'tool use completed without follow-up text');
        if (!followUpText) {
          callbacks.addMessage({role: 'assistant', text: 'Stopped after tool use without a follow-up response. You can ask me to continue if the task is not complete.'});
        }
      }
    } else if (sawToolCall) {
      const followUpText = await streamAssistantResponse(completedConversation, 'tool-only turn completed without text');
      if (!followUpText) {
        const fallback = toolSummaries.length > 0
          ? `Finished tool work but the model did not produce a final response. Last tool result: ${toolSummaries.at(-1)}.`
          : 'Finished without a text response.';
        callbacks.addMessage({id: assistantId, role: 'assistant', text: fallback, streaming: false});
      }
    } else {
      callbacks.addMessage({id: assistantId, role: 'assistant', text: 'Finished without a text response.', streaming: false});
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    callbacks.debugLog(`error: ${text}`);
    callbacks.addMessage({role: 'assistant', text: `Model call failed: ${text}`});
  } finally {
    callbacks.setBusy(false);
  }
}
