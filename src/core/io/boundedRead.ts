import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {TEXT_LINE_BYTES} from '../limits/byteBudgets.js';

export interface BoundedUtf8Line {
  line: string;
  lineNumber: number;
  oversized: boolean;
}

export async function* iterateBoundedUtf8Lines(file: string, maxLineBytes: number): AsyncGenerator<BoundedUtf8Line> {
  const input = createReadStream(file);
  let lineNumber = 0;
  let retained: Buffer[] = [];
  let retainedBytes = 0;
  let lineBytes = 0;

  const append = (segment: Buffer) => {
    lineBytes += segment.length;
    const remaining = maxLineBytes - retainedBytes;
    if (remaining <= 0) return;
    const kept = segment.subarray(0, remaining);
    if (kept.length > 0) {
      retained.push(kept);
      retainedBytes += kept.length;
    }
  };
  const finish = (): BoundedUtf8Line => {
    lineNumber++;
    let bytes = Buffer.concat(retained, retainedBytes);
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
    const oversized = lineBytes > maxLineBytes;
    const decoder = new StringDecoder('utf8');
    const line = oversized ? decoder.write(bytes) : bytes.toString('utf8');
    const result = {line, lineNumber, oversized};
    retained = [];
    retainedBytes = 0;
    lineBytes = 0;
    return result;
  };

  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1) {
        append(chunk.subarray(start));
        break;
      }
      append(chunk.subarray(start, newline));
      yield finish();
      start = newline + 1;
    }
  }
  if (lineBytes > 0 || retainedBytes > 0) yield finish();
}

export async function readUtf8LinesPage(file: string, offset: number, limit: number): Promise<{lines: string[]; totalLines: number}> {
  const lines: string[] = [];
  let totalLines = 0;
  for await (const entry of iterateBoundedUtf8Lines(file, TEXT_LINE_BYTES)) {
    totalLines = entry.lineNumber;
    if (totalLines >= offset && lines.length < limit) {
      lines.push(entry.oversized ? `${entry.line}\n[Line truncated at ${TEXT_LINE_BYTES} bytes]` : entry.line);
    }
  }
  const stat = await fs.stat(file);
  if (stat.size === 0) {
    totalLines = 1;
    if (offset <= 1 && limit > 0) lines.push('');
  } else {
    const handle = await fs.open(file, 'r');
    try {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, stat.size - 1);
      if (last[0] === 10) {
        totalLines++;
        if (totalLines >= offset && lines.length < limit) lines.push('');
      }
    } finally { await handle.close(); }
  }
  return {lines, totalLines};
}

export async function readUtf8Prefix(file: string, maxBytes: number): Promise<{content: string; truncated: boolean; totalBytes: number}> {
  const stat = await fs.stat(file);
  if (maxBytes <= 0) return {content: '', truncated: stat.size > 0, totalBytes: stat.size};
  const input = createReadStream(file, {start: 0, end: maxBytes - 1});
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const buffer = Buffer.concat(chunks);
  const decoder = new StringDecoder('utf8');
  const content = decoder.write(buffer) + (stat.size <= maxBytes ? decoder.end() : '');
  return {content, truncated: stat.size > maxBytes, totalBytes: stat.size};
}
