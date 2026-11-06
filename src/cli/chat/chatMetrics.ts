import os from 'node:os';
import type {ModelMessage} from 'ai';
import {modelMessageText} from '../../core/agent/compaction.js';
import {estimateValueTokens} from '../../core/agent/contextBudget.js';
import type {Message} from '../commands/streaming.js';
import type {TokenUsage} from '../commands/streaming/turnRuntime.js';
import {formatTokenCount} from '../../utils/format.js';

export function toolCallCount(messages: Message[]) {
  return messages.reduce((total, message) => {
    if (message.role !== 'tool') return total;
    // Live tool groups carry a structured count; only restored historical
    // transcripts fall back to counting rendered per-call rows (CR-015).
    if (typeof message.toolCount === 'number') return total + message.toolCount;
    return total + message.text.split('\n').filter(line => /^\s+[✓✗…]\s/.test(line)).length;
  }, 0);
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function compactHomePath(filePath: string, home = os.homedir()) {
  if (filePath === home) return '~';
  return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

export function displayMessagesFromConversation(conversation: ModelMessage[]): Message[] {
  return conversation.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const text = modelMessageText(message).trim();
    return text ? [{role: message.role, text} satisfies Message] : [];
  });
}

export function estimateConversationTokens(messages: Message[]) {
  const inputText = messages
    .filter(message => message.role === 'user' || message.role === 'tool')
    .map(message => message.text)
    .join('\n');
  const outputText = messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .join('\n');
  return {
    input: estimateTokens(inputText),
    output: estimateTokens(outputText),
  };
}

/** Status-bar numbers for the transcript, extracted so render stays declarative (CR-006). */
export function statusBarMetrics(input: {messages: Message[]; tokenUsage: TokenUsage; enabledSkillCount: number; backgroundProcessCount?: number}) {
  const {messages, tokenUsage, enabledSkillCount} = input;
  const assistantMessages = messages.filter(message => message.role === 'assistant' && !message.hidden).length;
  const toolsUsed = toolCallCount(messages);
  const fallbackTokens = estimateConversationTokens(messages);
  const estimatedLogicalInput = tokenUsage.logicalInputEstimate || fallbackTokens.input || 0;
  const providerInput = tokenUsage.inputTokens;
  const effectiveInput = providerInput == null ? estimatedLogicalInput : Math.max(providerInput, estimatedLogicalInput);
  const effectiveOutput = tokenUsage.outputTokens ?? (fallbackTokens.output || 0);
  const inputEstimated = providerInput == null || effectiveInput !== providerInput;
  const outputEstimated = tokenUsage.outputTokens == null;
  const backgroundLabel = input.backgroundProcessCount ? ` / ⏵ ${input.backgroundProcessCount} bg` : '';
  const statusDetailLabel = `${assistantMessages} message${assistantMessages === 1 ? '' : 's'} / ${toolsUsed} tool calls / LLM ${inputEstimated ? '~' : ''}↑${formatTokenCount(effectiveInput)} ${outputEstimated ? '~' : ''}↓${formatTokenCount(effectiveOutput)} / ${enabledSkillCount} skill${enabledSkillCount === 1 ? '' : 's'}${backgroundLabel}`;
  const hasTokenBreakdown = tokenUsage.systemPrompt > 0 || tokenUsage.messages > 0 || tokenUsage.toolSchemas > 0 || effectiveInput > 0 || effectiveOutput > 0;
  return {assistantMessages, toolsUsed, effectiveInput, effectiveOutput, inputEstimated, outputEstimated, statusDetailLabel, hasTokenBreakdown};
}

export interface FleetStatus {
  running: number;
  queued: number;
}

/**
 * Rolling fleet depth for the busy row, folded from coordinator events.
 * `queued` events report the queue length after enqueue; each later `started`
 * consumes one slot from it, terminal/settled events only move `running`.
 */
export function nextFleetStatus(current: FleetStatus | undefined, event: {type: string; state?: string; running?: number; queued?: number}): FleetStatus | undefined {
  if (event.type !== 'subagent_state') return current;
  const running = event.running ?? current?.running ?? 0;
  const queued = event.state === 'queued'
    ? event.queued ?? current?.queued ?? 0
    : Math.max(0, (current?.queued ?? 0) - (event.state === 'started' ? 1 : 0));
  return {running, queued};
}

/**
 * Busy-row detail for long turns: live generation rate of the streaming
 * message plus fleet depth, so a minutes-long turn shows it is progressing.
 * Pure and cheap enough for the one-second busy heartbeat.
 */
export function busyDetailLabel(input: {messages: Message[]; fleet?: FleetStatus; now?: number}): string | undefined {
  const parts: string[] = [];
  const streaming = [...input.messages].reverse()
    .find(message => message.role === 'assistant' && message.streaming && message.startedAt != null && message.text);
  if (streaming?.startedAt != null) {
    const seconds = Math.max(1, ((input.now ?? Date.now()) - streaming.startedAt) / 1000);
    const rate = Math.round(estimateValueTokens(streaming.text) / seconds);
    if (rate > 0) parts.push(`~${rate} tok/s`);
  }
  const fleet = input.fleet;
  if (fleet && (fleet.running > 0 || fleet.queued > 0)) {
    parts.push(`workers ${fleet.running} running${fleet.queued > 0 ? `, ${fleet.queued} queued` : ''}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
