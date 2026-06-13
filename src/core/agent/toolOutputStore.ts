import crypto from 'node:crypto';

export interface StoredToolOutputPage {
  handle: string;
  offset: number;
  nextOffset?: number;
  totalChars: number;
  content: string;
  truncated: boolean;
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

export function readToolOutput(handle: string, offset = 0, limit = 12_000): StoredToolOutputPage | undefined {
  const output = outputs.get(handle);
  if (output == null) return undefined;
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
