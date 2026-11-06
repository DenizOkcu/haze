import type {ModelMessage} from 'ai';
import type {SessionEntry} from './sessionStore.js';
import {SESSION_INLINE_VALUE_BYTES as INLINE_VALUE_BYTES, SESSION_PREVIEW_CHARS as PREVIEW_CHARS} from '../limits.js';
import {encodeSnapshotMessages} from './snapshotCodec.js';
import {redactUnknown} from '../safety/redaction.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
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

function prepareConversationSnapshot(messages: ModelMessage[]): ModelMessage[] {
  return encodeSnapshotMessages(messages);
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

export function prepareSessionEntryForWrite(entry: SessionEntry, options: {redactSecrets?: boolean} = {}): SessionEntry | undefined {
  const prepared = slimSessionEntry(entry);
  if (prepared === undefined) return undefined;
  // Opt-in secret-shape redaction (HZ-9): applied after slimming so it covers
  // every persisted entry type, including snapshots and event payloads.
  return options.redactSecrets === true ? redactUnknown(prepared) as SessionEntry : prepared;
}

function slimSessionEntry(entry: SessionEntry): SessionEntry | undefined {
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
        const output = isRecord(event.output) ? event.output : undefined;
        const validation = isRecord(output?.validationSummary) ? output.validationSummary : undefined;
        // Keep the outcome even when the output body is replaced by a preview.
        // The report needs only these enums, never command text or diagnostics.
        if (validation && typeof validation.kind === 'string' && (validation.status === 'passed' || validation.status === 'failed')) {
          event.validation = {kind: validation.kind, status: validation.status};
        }
        if (event.name === 'subagent' && typeof event.output === 'object' && event.output != null) {
          const telemetry = typeof output?.telemetry === 'object' && output.telemetry != null ? output.telemetry as Record<string, unknown> : undefined;
          event.output = {
            capsule: output?.capsule,
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
    return {...entry, messages: prepareConversationSnapshot(entry.messages)};
  }

  // Goal-ledger entries are small bounded metadata; only the request text is
  // capped (a pathological 256 KiB piped prompt must not bloat every boundary
  // append). Everything else passes through so the frontier is never dropped.
  if (entry.type === 'goal' && entry.request.length > GOAL_LEDGER_REQUEST_CHARS) {
    return {...entry, request: `${entry.request.slice(0, GOAL_LEDGER_REQUEST_CHARS)}…[ledger-truncated]`};
  }

  return entry;
}
