import type {ModelMessage} from 'ai';
import type {SessionEntry} from './sessionStore.js';

const INLINE_VALUE_BYTES = 32 * 1024;
const PREVIEW_CHARS = 4 * 1024;
const LARGE_STRING_CHARS = 8 * 1024;

function jsonByteLength(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Buffer.byteLength(String(value), 'utf8');
  }
}

function previewText(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}

function slimLargeValue(value: unknown) {
  const bytes = jsonByteLength(value);
  if (bytes <= INLINE_VALUE_BYTES) return value;
  return {
    omitted: true,
    reason: 'session_size_limit',
    originalBytes: bytes,
    preview: previewText(value),
  };
}

function slimUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    if (value.length <= LARGE_STRING_CHARS) return value;
    return `${value.slice(0, PREVIEW_CHARS)}\n\n[Session value truncated: ${value.length - PREVIEW_CHARS} characters omitted]`;
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => slimUnknown(item, seen));

  const record = value as Record<string, unknown>;
  if (record.type === 'tool-result') {
    return {
      ...record,
      output: slimLargeValue(record.output),
      result: slimLargeValue(record.result),
    };
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) next[key] = slimUnknown(child, seen);
  return next;
}

export function slimConversationSnapshot(messages: ModelMessage[]): ModelMessage[] {
  return slimUnknown(messages) as ModelMessage[];
}

function slimToolStartInput(input: unknown): Record<string, unknown> {
  // Full tool inputs (writeFile/editFile payloads can be tens of KB) are replaced
  // with byte counts; raw inputs stay only in opt-in --debug LLM logs (CR-031).
  const slimmed: Record<string, unknown> = {inputBytes: jsonByteLength(input)};
  if (typeof input === 'object' && input != null && typeof (input as Record<string, unknown>).path === 'string') {
    slimmed.path = (input as Record<string, unknown>).path;
  }
  return slimmed;
}

export function prepareSessionEntryForWrite(entry: SessionEntry): SessionEntry | undefined {
  if (entry.type === 'event') {
    if (entry.name === 'message_update') return undefined;
    if (entry.name === 'tool_start' && entry.text) {
      try {
        const event = JSON.parse(entry.text) as Record<string, unknown>;
        event.input = slimToolStartInput(event.input);
        return {...entry, text: JSON.stringify(event)};
      } catch {
        return entry;
      }
    }
    if (entry.name === 'tool_end' && entry.text) {
      try {
        const event = JSON.parse(entry.text) as Record<string, unknown>;
        if (event.name === 'subagent' && typeof event.output === 'object' && event.output != null) {
          const output = event.output as Record<string, unknown>;
          const telemetry = typeof output.telemetry === 'object' && output.telemetry != null ? output.telemetry as Record<string, unknown> : undefined;
          event.output = {
            capsule: output.capsule,
            coordinator: telemetry ? {modelSelector: telemetry.modelSelector, profile: telemetry.profile, durationMs: telemetry.durationMs, queueMs: telemetry.queueMs, toolCallCount: telemetry.toolCallCount} : undefined,
          };
        } else event.output = slimLargeValue(event.output);
        event.error = slimLargeValue(event.error);
        return {...entry, text: JSON.stringify(event)};
      } catch {
        return entry;
      }
    }
    return entry;
  }

  if (entry.type === 'conversation_snapshot') {
    return {...entry, messages: slimConversationSnapshot(entry.messages)};
  }

  return entry;
}

export const SESSION_INLINE_VALUE_BYTES = INLINE_VALUE_BYTES;
