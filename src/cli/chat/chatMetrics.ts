import os from 'node:os';
import type {ModelMessage} from 'ai';
import {modelMessageText} from '../../core/agent/compaction.js';
import type {Message} from '../commands/streaming.js';

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
