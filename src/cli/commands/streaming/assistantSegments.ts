import {agentEvent} from '../../../core/agent/events.js';
import type {StreamCallbacks} from '../streaming.js';
import {assistantDisplayText, normalizeAssistantText, isHiddenAssistantFragment, isHiddenUnstartedFinalText, isShortLeadInBeforeTool, isShortUnfinishedLeadIn} from './assistantText.js';
import {responseCompletionMetrics} from './turnRuntime.js';
import type {ToolGroupRenderer} from './toolGroupRenderer.js';
import type {AttemptLoopState} from './streamLoop.js';

/**
 * Assistant segment lifecycle (extracted from streamLoop.ts): one segment is
 * the text between tool calls (or the final answer). Segments start lazily
 * (gated by `shouldStartAssistantStream`), finalize with duplicate/lead-in
 * suppression, and reset for the next segment.
 */

export function resetAssistantSegment(loopState: AttemptLoopState) {
  loopState.currentAssistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  loopState.assistantStarted = false;
  loopState.assistantStartedAt = Date.now();
  loopState.currentAssistantText = '';
}

export function finalizeAssistantSegment(loopState: AttemptLoopState, callbacks: StreamCallbacks, options: {beforeTool?: boolean} = {}) {
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

/** Finalize any pending assistant text right before a tool call starts, demoting hidden lead-ins to the tool group caption. */
export function finalizePendingAssistantBeforeTool(deps: {loopState: AttemptLoopState; callbacks: StreamCallbacks; toolDisplay: ToolGroupRenderer}) {
  const {loopState, callbacks, toolDisplay} = deps;
  if (loopState.currentAssistantText.trim().length > 0 || loopState.assistantStarted) {
    const pending = assistantDisplayText(loopState.currentAssistantText);
    const shown = finalizeAssistantSegment(loopState, callbacks, {beforeTool: true});
    if (!shown && pending) toolDisplay.setGroupCaption(pending);
  }
}
