import crypto from 'node:crypto';
import {TOOL_OUTPUT_ENTRY_BYTES, TOOL_OUTPUT_TOTAL_BYTES} from '../limits.js';
import {truncateUtf8AtBytes} from '../../utils/utf8.js';

export interface StoredToolOutputPage {
  handle: string;
  offset: number;
  nextOffset?: number;
  totalChars: number;
  totalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  content: string;
  truncated: boolean;
  query?: string;
  matches?: number;
}

const outputs = new Map<string, {content: string; bytes: number; originalBytes: number}>();
const dynamicOutputs = new Map<string, () => {content: string; totalBytes: number}>();
const MAX_STORED_OUTPUTS = 100;
let storedBytes = 0;

export function registerDynamicToolOutput(read: () => {content: string; totalBytes: number}) {
  const handle = `output-${crypto.randomBytes(8).toString('hex')}`;
  dynamicOutputs.set(handle, read);
  return handle;
}

export function unregisterDynamicToolOutput(handle: string) {
  dynamicOutputs.delete(handle);
}

/**
 * Store a tool output and return a handle for later retrieval.
 *
 * Two eviction pressures apply: count (`MAX_STORED_OUTPUTS`) and total bytes
 * (`TOOL_OUTPUT_TOTAL_BYTES`). A single entry that alone exceeds the byte
 * budget is evicted on the next `storeToolOutput` call, so callers should not
 * assume a freshly-stored handle survives beyond the next store.
 */
export function storeToolOutput(content: string) {
  const handle = `output-${crypto.randomBytes(8).toString('hex')}`;
  const originalBytes = Buffer.byteLength(content, 'utf8');
  const retained = truncateUtf8AtBytes(content, TOOL_OUTPUT_ENTRY_BYTES).text;
  const bytes = Buffer.byteLength(retained, 'utf8');
  outputs.set(handle, {content: retained, bytes, originalBytes});
  storedBytes += bytes;
  while (outputs.size > MAX_STORED_OUTPUTS || storedBytes > TOOL_OUTPUT_TOTAL_BYTES) {
    const oldest = outputs.keys().next().value;
    if (!oldest) break;
    storedBytes -= outputs.get(oldest)?.bytes ?? 0;
    outputs.delete(oldest);
  }
  return handle;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchOutput(output: string, query: string, limit: number, contextLines = 2): Omit<StoredToolOutputPage, 'handle' | 'totalBytes' | 'retainedBytes' | 'omittedBytes'> {
  const pattern = new RegExp(escapeRegex(query), 'i');
  const lines = output.split(/\r?\n/);
  const ranges: Array<{start: number; end: number}> = [];
  for (let index = 0; index < lines.length; index++) {
    if (!pattern.test(lines[index] ?? '')) continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({start, end});
  }
  const chunks: string[] = [];
  for (const range of ranges) {
    if (chunks.length) chunks.push('--');
    for (let index = range.start; index <= range.end; index++) chunks.push(`${index + 1}: ${lines[index] ?? ''}`);
  }
  const content = chunks.join('\n');
  return {offset: 0, totalChars: output.length, content: content.slice(0, limit), truncated: content.length > limit, query, matches: ranges.length};
}

export function readToolOutput(handle: string, offset = 0, limit = 12_000, options?: {query?: string; contextLines?: number}): StoredToolOutputPage | undefined {
  const dynamic = dynamicOutputs.get(handle)?.();
  const stored = dynamic
    ? {content: dynamic.content, bytes: Buffer.byteLength(dynamic.content, 'utf8'), originalBytes: dynamic.totalBytes}
    : outputs.get(handle);
  if (stored == null) return undefined;
  // Refresh recency so reads protect entries from LRU eviction (CR-019).
  if (!dynamic) {
    outputs.delete(handle);
    outputs.set(handle, stored);
  }
  const output = stored.content;
  if (options?.query?.trim()) {
    const result = searchOutput(output, options.query.trim(), limit, options.contextLines);
    const omittedBytes = stored.originalBytes - stored.bytes;
    return {...result, handle, truncated: result.truncated || omittedBytes > 0, totalBytes: stored.originalBytes, retainedBytes: stored.bytes, omittedBytes};
  }
  const safeOffset = Math.min(Math.max(0, offset), output.length);
  const content = output.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + content.length < output.length ? safeOffset + content.length : undefined;
  return {
    handle,
    offset: safeOffset,
    ...(nextOffset == null ? {} : {nextOffset}),
    totalChars: output.length,
    totalBytes: stored.originalBytes,
    retainedBytes: stored.bytes,
    omittedBytes: stored.originalBytes - stored.bytes,
    content,
    truncated: nextOffset != null || stored.originalBytes > stored.bytes,
  };
}

export function clearToolOutputs() {
  outputs.clear();
  storedBytes = 0;
}
