import type {ModelMessage} from 'ai';
import {estimateValueTokens} from './contextBudget.js';

export const SYNTHETIC_CONTROL_OPEN = '<haze_control>';

export function toolRequestSettings<T extends Record<string, unknown>>(tools: T, allowTools: boolean) {
  return allowTools ? {tools, toolChoice: 'auto' as const} : {};
}

export function isSyntheticControlMessage(message: ModelMessage) {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(SYNTHETIC_CONTROL_OPEN);
}

export function stripSyntheticControls(messages: ModelMessage[]) {
  return messages.filter(message => !isSyntheticControlMessage(message));
}

export function withSyntheticControl(messages: ModelMessage[], control: string): ModelMessage[] {
  return [
    ...stripSyntheticControls(messages),
    {role: 'user', content: `${SYNTHETIC_CONTROL_OPEN}\n${control}\n</haze_control>`},
  ];
}

function resultValue(output: unknown) {
  return typeof output === 'object' && output != null && 'value' in output
    ? (output as {value?: unknown}).value
    : undefined;
}

function isFailedResult(output: unknown) {
  if (typeof output !== 'object' || output == null || !('type' in output)) return true;
  const type = (output as {type?: unknown}).type;
  if (type === 'error-text' || type === 'error-json' || type === 'execution-denied') return true;
  const value = resultValue(output);
  return typeof value === 'object' && value != null && 'ok' in value && value.ok === false;
}

function compactJsonValue(value: unknown, toolName: string) {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    return {compacted: true, toolName, summary: 'Older successful tool result omitted.'};
  }
  const source = value as Record<string, unknown>;
  const keys = [
    'ok', 'path', 'command', 'code', 'signal', 'timedOut', 'durationMs', 'reasonCode',
    'bytes', 'created', 'replacements', 'totalMatches', 'returnedMatches',
    'omittedMatches', 'truncated', 'nextOffset', 'totalLines', 'startLine', 'endLine',
    'validationSummary', 'classification', 'summary', 'counts',
  ];
  const compacted: Record<string, unknown> = {compacted: true, toolName};
  for (const key of keys) if (key in source) compacted[key] = source[key];
  for (const stream of ['stdout', 'stderr']) {
    const candidate = source[stream];
    if (typeof candidate !== 'object' || candidate == null) continue;
    const details = candidate as Record<string, unknown>;
    compacted[stream] = {
      ...(typeof details.handle === 'string' ? {handle: details.handle} : {}),
      ...(typeof details.truncated === 'boolean' ? {truncated: details.truncated} : {}),
      ...(typeof details.omittedChars === 'number' ? {omittedChars: details.omittedChars} : {}),
    };
  }
  return compacted;
}

function compactResultOutput(output: unknown, toolName: string) {
  if (typeof output !== 'object' || output == null || !('type' in output)) return output;
  const typed = output as {type?: unknown; value?: unknown};
  if (typed.type === 'json') return {...typed, value: compactJsonValue(typed.value, toolName)};
  if (typed.type === 'text') return {...typed, value: `[Older successful ${toolName} result omitted from active context.]`};
  return output;
}

const COMPACTABLE_INPUT_TOOLS = new Set(['writeFile', 'bash']);
const BASH_COMMAND_TRUNCATE_THRESHOLD = 200;
const BASH_COMMAND_KEEP_CHARS = 150;

function compactToolCallInput(input: unknown, toolName: string): unknown {
  if (typeof input !== 'object' || input == null) return input;
  const source = input as Record<string, unknown>;
  if (toolName === 'writeFile' && typeof source.content === 'string') {
    const bytes = source.content.length;
    const path = typeof source.path === 'string' ? source.path : '<unknown>';
    return {
      ...source,
      content: `[Compacted: original ${bytes} bytes. Use readFile on "${path}" to inspect.]`,
    };
  }
  if (toolName === 'bash' && typeof source.command === 'string' && source.command.length > BASH_COMMAND_TRUNCATE_THRESHOLD) {
    const total = source.command.length;
    const truncated = source.command.slice(0, BASH_COMMAND_KEEP_CHARS).replace(/\s+/g, ' ').trim();
    return {
      ...source,
      command: `${truncated} [+${total - BASH_COMMAND_KEEP_CHARS} more chars compacted]`,
    };
  }
  return input;
}

export function compactToolHistory(
  messages: ModelMessage[],
  options: {keepRecentResults?: number; minResultTokens?: number; keepRecentCalls?: number; minCallTokens?: number} = {},
) {
  const keepRecentResults = options.keepRecentResults ?? 3;
  const minResultTokens = options.minResultTokens ?? 300;
  const keepRecentCalls = options.keepRecentCalls ?? 3;
  const minCallTokens = options.minCallTokens ?? 400;

  const resultIds: string[] = [];
  const compactableCallIds: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== 'object' || part == null) continue;
      if (part.type === 'tool-result' && typeof part.toolCallId === 'string') resultIds.push(part.toolCallId);
      else if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && COMPACTABLE_INPUT_TOOLS.has(part.toolName)) compactableCallIds.push(part.toolCallId);
    }
  }
  const recent = new Set(keepRecentResults > 0 ? resultIds.slice(-keepRecentResults) : []);
  const recentCallIds = new Set(keepRecentCalls > 0 ? compactableCallIds.slice(-keepRecentCalls) : []);
  let compactedResults = 0;
  let compactedCalls = 0;
  const next = messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map(part => {
      if (typeof part !== 'object' || part == null) return part;
      if (part.type === 'tool-result') {
        if (recent.has(part.toolCallId) || isFailedResult(part.output) || estimateValueTokens(part) < minResultTokens) return part;
        changed = true;
        compactedResults += 1;
        return {...part, output: compactResultOutput(part.output, part.toolName)};
      }
      if (part.type === 'tool-call' && COMPACTABLE_INPUT_TOOLS.has(part.toolName)) {
        if (recentCallIds.has(part.toolCallId) || estimateValueTokens(part) < minCallTokens) return part;
        changed = true;
        compactedCalls += 1;
        return {...part, input: compactToolCallInput(part.input, part.toolName)};
      }
      return part;
    });
    return changed ? {...message, content} as ModelMessage : message;
  });
  return {messages: next, compactedResults, compactedCalls};
}
