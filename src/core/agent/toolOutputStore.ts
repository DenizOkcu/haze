import crypto from 'node:crypto';

export interface StoredToolOutputPage {
  handle: string;
  offset: number;
  nextOffset?: number;
  totalChars: number;
  content: string;
  truncated: boolean;
  query?: string;
  matches?: number;
}

const outputs = new Map<string, string>();
const MAX_STORED_OUTPUTS = 100;

export function storeToolOutput(content: string) {
  const handle = `output-${crypto.randomBytes(8).toString('hex')}`;
  outputs.set(handle, content);
  while (outputs.size > MAX_STORED_OUTPUTS) {
    const oldest = outputs.keys().next().value as string | undefined;
    if (!oldest) break;
    outputs.delete(oldest);
  }
  return handle;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchOutput(output: string, query: string, limit: number, contextLines = 2): StoredToolOutputPage {
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
  return {handle: '', offset: 0, totalChars: output.length, content: content.slice(0, limit), truncated: content.length > limit, query, matches: ranges.length};
}

export function readToolOutput(handle: string, offset = 0, limit = 12_000, options?: {query?: string; contextLines?: number}): StoredToolOutputPage | undefined {
  const output = outputs.get(handle);
  if (output == null) return undefined;
  if (options?.query?.trim()) {
    const result = searchOutput(output, options.query.trim(), limit, options.contextLines);
    return {...result, handle};
  }
  const safeOffset = Math.min(Math.max(0, offset), output.length);
  const content = output.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + content.length < output.length ? safeOffset + content.length : undefined;
  return {
    handle,
    offset: safeOffset,
    ...(nextOffset == null ? {} : {nextOffset}),
    totalChars: output.length,
    content,
    truncated: nextOffset != null,
  };
}

export function clearToolOutputs() {
  outputs.clear();
}
