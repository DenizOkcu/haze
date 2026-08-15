import type {ModelMessage} from 'ai';
import {estimateModelMessageTokens} from './contextBudget.js';
import {workStatePrompt, type WorkState} from './workState.js';
import {COMPACTION_LLM_TRANSCRIPT_CHARS, COMPACTION_OLDER_CHARS} from '../limits/textBudgets.js';

export interface CompactionResult {
  compacted: boolean;
  messages: ModelMessage[];
  olderCount: number;
  keptCount: number;
  summary?: string;
}

export interface CompactionSplit {
  older: ModelMessage[];
  recent: ModelMessage[];
}

/**
 * Decide which trailing messages survive compaction and which are folded into
 * the summary. Returns undefined when there is nothing older to compact (the
 * whole history is recent, or the recent window reaches back past the first
 * message once trailing tool messages are reattached to their calls).
 * Shared by the heuristic and the LLM-summarized paths (F-09).
 */
export function splitForCompaction(
  messages: ModelMessage[],
  options: {keepRecentMessages?: number; tokenBudget?: number} = {},
): CompactionSplit | undefined {
  const maxRecentMessages = Math.min(options.keepRecentMessages ?? 12, messages.length);
  let keepRecentMessages = maxRecentMessages;
  if (options.tokenBudget != null) {
    let recentTokens = 0;
    keepRecentMessages = 0;
    for (let index = messages.length - 1; index >= 0 && keepRecentMessages < maxRecentMessages; index--) {
      const tokens = estimateModelMessageTokens(messages[index]!);
      if (keepRecentMessages > 0 && recentTokens + tokens > options.tokenBudget) break;
      recentTokens += tokens;
      keepRecentMessages += 1;
    }
  }
  if (messages.length <= keepRecentMessages) return undefined;

  let recentStart = messages.length - keepRecentMessages;
  while (recentStart > 0 && messages[recentStart]?.role === 'tool') recentStart -= 1;
  if (recentStart === 0) return undefined;
  return {older: messages.slice(0, recentStart), recent: messages.slice(recentStart)};
}

export function modelMessageText(message: ModelMessage) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'object' && part != null && 'text' in part && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

export function compactModelMessages(
  messages: ModelMessage[],
  options: {keepRecentMessages?: number; tokenBudget?: number; instructions?: string; workState?: WorkState} = {},
): CompactionResult {
  const split = splitForCompaction(messages, options);
  if (!split) return {compacted: false, messages, olderCount: 0, keptCount: messages.length};
  const {older, recent} = split;
  const olderEntries = older.map(message => {
    const text = modelMessageText(message).replace(/\s+/g, ' ').trim();
    return text ? `- ${message.role}: ${text}` : '';
  }).filter(Boolean);
  // Keep the excerpt bounded, favoring the most recent older messages (CR-008).
  const keptEntries: string[] = [];
  let excerptChars = 0;
  for (let index = olderEntries.length - 1; index >= 0; index--) {
    const entry = olderEntries[index]!;
    if (excerptChars + entry.length + 1 > COMPACTION_OLDER_CHARS && keptEntries.length > 0) break;
    keptEntries.unshift(entry);
    excerptChars += entry.length + 1;
  }
  const omittedEntries = olderEntries.length - keptEntries.length;
  const oldText = keptEntries.join('\n');
  const summary = [
    'Compacted prior haze conversation. Treat this as continuity context, not a new user request.',
    'Preserve especially: current user goal and success condition; explicit user constraints/preferences/decisions; files created/changed/read; validation commands and pass/fail results; blockers or pending product decisions; exact next action if work was unfinished.',
    'Do not treat older tool outputs as current unless the recent conversation confirms they still apply.',
    options.instructions ? `User compaction instructions: ${options.instructions}` : undefined,
    options.workState ? workStatePrompt(options.workState) : undefined,
    '',
    'Older context excerpt (whitespace-collapsed, most recent first within a bounded budget):',
    oldText || '- Older messages were tool-only or non-text.',
    omittedEntries > 0 ? `[${omittedEntries} older message(s) omitted from the excerpt to keep compaction bounded; rely on the preserved points above.]` : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');

  return {
    compacted: true,
    messages: [{role: 'user', content: `<haze_compaction>\n${summary}\n</haze_compaction>`}, ...recent],
    olderCount: older.length,
    keptCount: recent.length,
    summary,
  };
}

/**
 * Build the summarization request for the LLM-summarized compaction path
 * (F-09). The transcript is the older half, bounded to a character budget and
 * truncated from the front (the oldest context is the least valuable) so the
 * request itself can never overflow the model.
 */
export function buildLlmCompactionPrompt(input: {older: ModelMessage[]; instructions?: string; maxChars?: number}): string {
  const maxChars = input.maxChars ?? COMPACTION_LLM_TRANSCRIPT_CHARS;
  const entries = input.older.map(message => {
    const text = modelMessageText(message).replace(/\s+/g, ' ').trim();
    return text ? `- ${message.role}: ${text}` : '';
  }).filter(Boolean);
  // Keep the most recent entries within the bound; drop whole oldest entries
  // first, then hard-trim whatever single entry still exceeds the budget.
  const kept: string[] = [];
  let total = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (total + entry.length + 1 > maxChars && kept.length > 0) break;
    kept.unshift(entry);
    total += entry.length + 1;
  }
  if (kept.length === 1 && kept[0]!.length > maxChars) kept[0] = `${kept[0]!.slice(kept[0]!.length - maxChars)}…`;
  const omitted = entries.length - kept.length;
  return [
    'Summarize the following older conversation history for continuity. The summary replaces the history in a coding agent context.',
    'Preserve: current user goal and success condition; explicit user constraints, preferences, and decisions; files created/changed/read; validation commands and their pass/fail results; blockers or pending decisions; the exact next action if work was unfinished.',
    'Drop: restatements, exploration dead ends that led nowhere, raw tool output detail, and anything the recent messages supersede.',
    input.instructions ? `User compaction instructions: ${input.instructions}` : undefined,
    `Write a dense summary in at most 60 lines. ${omitted > 0 ? `(${omitted} oldest message(s) already omitted from this transcript.)` : ''}`.trim(),
    '',
    '<older_conversation>',
    ...kept,
    '</older_conversation>',
  ].filter((line): line is string => line !== undefined).join('\n');
}

/**
 * Assemble the compacted history around a model-written summary (F-09). Same
 * split rules as the heuristic path; the excerpt is replaced by the summary
 * text the model produced.
 */
export function compactModelMessagesWithSummary(
  messages: ModelMessage[],
  options: {summaryText: string; keepRecentMessages?: number; tokenBudget?: number; instructions?: string; workState?: WorkState},
): CompactionResult {
  const split = splitForCompaction(messages, options);
  if (!split) return {compacted: false, messages, olderCount: 0, keptCount: messages.length};
  const summary = [
    'Compacted prior haze conversation. Treat this as continuity context, not a new user request.',
    'Do not treat older tool outputs as current unless the recent conversation confirms they still apply.',
    options.instructions ? `User compaction instructions: ${options.instructions}` : undefined,
    options.workState ? workStatePrompt(options.workState) : undefined,
    '',
    'Model-written summary of the older conversation:',
    options.summaryText.trim(),
  ].filter((line): line is string => line !== undefined).join('\n');
  return {
    compacted: true,
    messages: [{role: 'user', content: `<haze_compaction>\n${summary}\n</haze_compaction>`}, ...split.recent],
    olderCount: split.older.length,
    keptCount: split.recent.length,
    summary,
  };
}
