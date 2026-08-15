import os from 'node:os';
import type {ModelMessage} from 'ai';
import {modelMessageText} from '../../core/agent/compaction.js';
import {formatCostUsd} from '../../core/agent/costAccounting.js';
import type {Message, TokenUsage} from '../commands/streaming.js';

export function toolCallCount(messages: Message[]) {
  return messages.reduce((total, message) => {
    if (message.role !== 'tool') return total;
    // Live tool groups carry a structured count; only restored historical
    // transcripts fall back to counting rendered per-call rows (CR-015).
    if (typeof message.toolCount === 'number') return total + message.toolCount;
    return total + message.text.split('\n').filter(line => /^\s+[✓✗…]\s/.test(line)).length;
  }, 0);
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function compactHomePath(filePath: string, home = os.homedir()) {
  if (filePath === home) return '~';
  return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

export function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(tokens);
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
  const hazeMessages = messages.filter(message => message.role === 'assistant' && !message.hidden).length;
  const toolsUsed = toolCallCount(messages);
  const fallbackTokens = estimateConversationTokens(messages);
  const estimatedLogicalInput = tokenUsage.logicalInputEstimate || fallbackTokens.input || 0;
  const providerInput = tokenUsage.inputTokens;
  const effectiveInput = providerInput == null ? estimatedLogicalInput : Math.max(providerInput, estimatedLogicalInput);
  const effectiveOutput = tokenUsage.outputTokens ?? (fallbackTokens.output || 0);
  const inputEstimated = providerInput == null || effectiveInput !== providerInput;
  const outputEstimated = tokenUsage.outputTokens == null;
  const backgroundLabel = input.backgroundProcessCount ? ` / ⏵ ${input.backgroundProcessCount} bg` : '';
  const costLabel = tokenUsage.costUsd != null ? ` / ${formatCostUsd(tokenUsage.costUsd)}` : '';
  const statusDetailLabel = `${hazeMessages} haze message${hazeMessages === 1 ? '' : 's'} / ${toolsUsed} tool call${toolsUsed === 1 ? '' : 's'} / LLM ${inputEstimated ? '~' : ''}↑${formatTokenCount(effectiveInput)} ${outputEstimated ? '~' : ''}↓${formatTokenCount(effectiveOutput)} / ${enabledSkillCount} skill${enabledSkillCount === 1 ? '' : 's'}${backgroundLabel}${costLabel}`;
  const hasTokenBreakdown = tokenUsage.systemPrompt > 0 || tokenUsage.messages > 0 || tokenUsage.toolSchemas > 0 || effectiveInput > 0 || effectiveOutput > 0;
  return {hazeMessages, toolsUsed, effectiveInput, effectiveOutput, inputEstimated, outputEstimated, statusDetailLabel, hasTokenBreakdown};
}
