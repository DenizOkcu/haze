import type {ModelMessage} from 'ai';
import type {SessionEntry} from './sessionStore.js';
import {SESSION_INLINE_VALUE_BYTES as INLINE_VALUE_BYTES, SESSION_LARGE_STRING_CHARS as LARGE_STRING_CHARS, SESSION_PREVIEW_CHARS as PREVIEW_CHARS} from '../limits.js';
import {imageFilePartBytes, isImageFilePart} from '../attachments/imageAttachments.js';
import {formatBytes} from '../../utils/format.js';

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

/**
 * Image file parts become text placeholders (F03): resumed sessions must not
 * replay megabytes of base64, and the placeholder stays a protocol-safe
 * ModelMessage part for any provider. The model re-asks if it needs the image.
 */
function slimImageFilePart(part: Record<string, unknown>) {
  const bytes = imageFilePartBytes(part.data);
  const name = typeof part.filename === 'string' && part.filename ? ` ${part.filename}` : '';
  return {
    type: 'text',
    text: `[image omitted from session:${name} ${part.mediaType}, ${formatBytes(bytes)} — ask the user to re-attach it if needed]`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

/**
 * Slim a tool-result output while preserving the AI SDK output envelope.
 * Restored snapshots are re-sent to providers, and `modelMessageSchema` requires
 * a tool-result output to be `{type: 'json'|'text'|... , value}`; a bare slim
 * marker as the output made every resumed session fail with
 * AI_InvalidPromptError (F-09 regression).
 */
function slimToolResultOutput(output: unknown) {
  if (!isRecord(output) || typeof output.type !== 'string' || !('value' in output)) return slimLargeValue(output);
  return {...output, value: slimLargeValue(output.value)};
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
  if (isImageFilePart(record)) return slimImageFilePart(record);
  if (record.type === 'tool-result') {
    return {
      ...record,
      output: slimToolResultOutput(record.output),
      result: slimLargeValue(record.result),
    };
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) next[key] = slimUnknown(child, seen);
  return next;
}

/**
 * Restore-side repair (F-09): sessions written before the envelope fix store
 * bare `{omitted, reason, originalBytes, preview}` slim markers as tool-result
 * outputs. Re-sending those to a provider fails `modelMessageSchema`, so wrap
 * each legacy marker back into the required `{type, value}` envelope. Already
 * valid outputs pass through untouched.
 */
function repairLegacySlimmedMessages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const repaired = messages.map(message => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = (message.content as unknown[]).map(part => {
      if (!isRecord(part) || part.type !== 'tool-result') return part;
      if (!isLegacySlimMarker(part.output)) return part;
      messageChanged = true;
      return {...part, output: {type: 'json' as const, value: part.output}};
    });
    if (!messageChanged) return message;
    changed = true;
    return {...message, content: content as typeof message.content};
  });
  return changed ? repaired : messages;
}

function isLegacySlimMarker(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.omitted === true && value.reason === 'session_size_limit' && !('type' in value);
}

export function repairRestoredConversation(messages: ModelMessage[]): ModelMessage[] {
  return repairLegacySlimmedMessages(messages);
}

function slimConversationSnapshot(messages: ModelMessage[]): ModelMessage[] {
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

/** Goal-ledger request text bound; the exact bytes live in conversation snapshots, the ledger needs a resumable copy (P1). */
const GOAL_LEDGER_REQUEST_CHARS = 1024;

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

  // Goal-ledger entries are small bounded metadata; only the request text is
  // capped (a pathological 256 KiB piped prompt must not bloat every boundary
  // append). Everything else passes through so the frontier is never dropped.
  if (entry.type === 'goal' && entry.request.length > GOAL_LEDGER_REQUEST_CHARS) {
    return {...entry, request: `${entry.request.slice(0, GOAL_LEDGER_REQUEST_CHARS)}…[ledger-truncated]`};
  }

  return entry;
}
