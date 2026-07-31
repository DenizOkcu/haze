import {createReadStream, type Stats} from 'node:fs';
import fs from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {TEXT_LINE_BYTES} from '../limits/byteBudgets.js';

export interface BoundedUtf8Line {
  line: string;
  lineNumber: number;
  oversized: boolean;
}

async function* iterateBoundedUtf8LinesFrom(file: string, maxLineBytes: number, startByte: number, previousLineNumber: number): AsyncGenerator<BoundedUtf8Line> {
  const input = createReadStream(file, startByte > 0 ? {start: startByte} : undefined);
  let lineNumber = previousLineNumber;
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

export async function* iterateBoundedUtf8Lines(file: string, maxLineBytes: number): AsyncGenerator<BoundedUtf8Line> {
  yield* iterateBoundedUtf8LinesFrom(file, maxLineBytes, 0, 0);
}

type LineCheckpoint = {lineNumber: number; byteOffset: number};
type LineIndex = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  totalLines: number;
  trailingNewline: boolean;
  checkpoints: LineCheckpoint[];
};

const MAX_LINE_INDEX_FILES = 8;
const MAX_LINE_CHECKPOINTS = 8_192;
const lineIndexCache = new Map<string, LineIndex>();

function sameFileSignature(index: LineIndex, stat: Stats) {
  return index.size === stat.size && index.mtimeMs === stat.mtimeMs && index.ctimeMs === stat.ctimeMs;
}

async function buildLineIndex(file: string, stat: Stats): Promise<LineIndex> {
  let totalLines = 1;
  let byteOffset = 0;
  let stride = 256;
  let trailingNewline = false;
  let checkpoints: LineCheckpoint[] = [{lineNumber: 1, byteOffset: 0}];
  for await (const value of createReadStream(file)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      if (newline === -1) break;
      totalLines++;
      const lineStart = byteOffset + newline + 1;
      if ((totalLines - 1) % stride === 0) checkpoints.push({lineNumber: totalLines, byteOffset: lineStart});
      if (checkpoints.length > MAX_LINE_CHECKPOINTS) {
        stride *= 2;
        checkpoints = checkpoints.filter(point => (point.lineNumber - 1) % stride === 0);
      }
      cursor = newline + 1;
    }
    trailingNewline = chunk.length > 0 ? chunk[chunk.length - 1] === 10 : trailingNewline;
    byteOffset += chunk.length;
  }
  return {size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, totalLines, trailingNewline, checkpoints};
}

async function lineIndex(file: string) {
  const stat = await fs.stat(file);
  const cached = lineIndexCache.get(file);
  if (cached && sameFileSignature(cached, stat)) {
    lineIndexCache.delete(file);
    lineIndexCache.set(file, cached);
    return cached;
  }
  const index = await buildLineIndex(file, stat);
  lineIndexCache.delete(file);
  lineIndexCache.set(file, index);
  while (lineIndexCache.size > MAX_LINE_INDEX_FILES) {
    const oldest = lineIndexCache.keys().next().value;
    if (oldest == null) break;
    lineIndexCache.delete(oldest);
  }
  return index;
}

export async function readUtf8LinesPage(file: string, offset: number, limit: number): Promise<{lines: string[]; totalLines: number}> {
  const index = await lineIndex(file);
  const lines: string[] = [];
  if (limit <= 0 || offset > index.totalLines) return {lines, totalLines: index.totalLines};
  let checkpoint = index.checkpoints[0]!;
  for (const candidate of index.checkpoints) {
    if (candidate.lineNumber > offset) break;
    checkpoint = candidate;
  }
  for await (const entry of iterateBoundedUtf8LinesFrom(file, TEXT_LINE_BYTES, checkpoint.byteOffset, checkpoint.lineNumber - 1)) {
    if (entry.lineNumber < offset) continue;
    lines.push(entry.oversized ? `${entry.line}\n[Line truncated at ${TEXT_LINE_BYTES} bytes]` : entry.line);
    if (lines.length >= limit) break;
  }
  const includesSyntheticLastLine = index.size === 0 || index.trailingNewline;
  if (includesSyntheticLastLine && offset <= index.totalLines && index.totalLines < offset + limit && lines.length < limit) lines.push('');
  return {lines, totalLines: index.totalLines};
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
