import type {ModelMessage} from 'ai';

export interface CompactionResult {
  compacted: boolean;
  messages: ModelMessage[];
  olderCount: number;
  keptCount: number;
  summary?: string;
}

export function modelMessageText(message: ModelMessage) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'object' && part != null && 'text' in part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

export function compactModelMessages(
  messages: ModelMessage[],
  options: {keepRecentMessages?: number; instructions?: string} = {},
): CompactionResult {
  const keepRecentMessages = options.keepRecentMessages ?? 12;
  if (messages.length <= keepRecentMessages) {
    return {compacted: false, messages, olderCount: 0, keptCount: messages.length};
  }

  const older = messages.slice(0, -keepRecentMessages);
  const recent = messages.slice(-keepRecentMessages);
  const oldText = older.map(message => {
    const text = modelMessageText(message).replace(/\s+/g, ' ').trim();
    return text ? `- ${message.role}: ${text.slice(0, 500)}` : '';
  }).filter(Boolean).join('\n');
  const summary = [
    'Compacted prior Haze conversation. Treat this as continuity context, not a new user request.',
    'Preserve especially: current user goal and success condition; explicit user constraints/preferences/decisions; files created/changed/read; validation commands and pass/fail results; blockers or pending product decisions; exact next action if work was unfinished.',
    'Do not treat older tool outputs as current unless the recent conversation confirms they still apply.',
    options.instructions ? `User compaction instructions: ${options.instructions}` : undefined,
    '',
    'Older context summary:',
    oldText || '- Older messages were tool-only or non-text.',
  ].filter((line): line is string => line !== undefined).join('\n');

  return {
    compacted: true,
    messages: [{role: 'system', content: summary}, ...recent],
    olderCount: older.length,
    keptCount: recent.length,
    summary,
  };
}
