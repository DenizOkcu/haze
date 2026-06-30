import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {HAZE_DIR} from '../../config/paths.js';

export interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  timestamp: string;
}

export interface ReadMemoryEntriesResult {
  entries: MemoryEntry[];
  parseErrors: string[];
}

const DEFAULT_MEMORY_DIR = path.join(HAZE_DIR, 'memory');
const MEMORY_FILE = 'memory.jsonl';
const MAX_ENTRIES = 200;

export function cwdHash(cwd = process.cwd()) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export function memoryDir(cwd = process.cwd(), baseDir = DEFAULT_MEMORY_DIR) {
  return path.join(baseDir, cwdHash(cwd));
}

export function memoryFile(cwd = process.cwd(), baseDir = DEFAULT_MEMORY_DIR) {
  return path.join(memoryDir(cwd, baseDir), MEMORY_FILE);
}

/**
 * Write a JSONL file atomically: serialize to a temp file in the same directory,
 * then rename into place. This mirrors the crash-safety pattern used elsewhere
 * in Haze and avoids readers observing a partially-written file.
 */
async function atomicWriteJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  const lines = entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '');
  await fs.writeFile(tmpPath, lines, 'utf8');
  await fs.rename(tmpPath, filePath);
}

function normalizeTags(tags?: string[]): string[] {
  return (tags ?? [])
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag.length > 0);
}

function isEnoent(error: unknown): error is {code: 'ENOENT'} & Error {
  return typeof error === 'object' && error !== null && 'code' in error && (error as {code?: unknown}).code === 'ENOENT';
}

function warnParseErrors(file: string, parseErrors: string[]): void {
  if (parseErrors.length === 0) return;
  console.warn(`[haze memory] ignoring ${parseErrors.length} corrupted line(s) in ${file}: ${parseErrors.join('; ')}`);
}

export async function storeMemory(input: {
  key: string;
  value: string;
  tags?: string[];
  cwd?: string;
  baseDir?: string;
  timestamp?: string;
}): Promise<MemoryEntry> {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const file = memoryFile(cwd, input.baseDir);
  const entry: MemoryEntry = {
    key: input.key.trim(),
    value: input.value,
    tags: normalizeTags(input.tags),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(file), {recursive: true});
  const {entries, parseErrors} = await readMemoryEntries(cwd, input.baseDir);
  warnParseErrors(file, parseErrors);
  const entriesToWrite = [...entries, entry];
  if (entriesToWrite.length > MAX_ENTRIES) {
    entriesToWrite.splice(0, entriesToWrite.length - MAX_ENTRIES);
  }
  await atomicWriteJsonl(file, entriesToWrite);
  return entry;
}

export async function searchMemory(query: string, cwd = process.cwd(), baseDir = DEFAULT_MEMORY_DIR): Promise<MemoryEntry[]> {
  const normalizedQuery = query.toLowerCase();
  const file = memoryFile(cwd, baseDir);
  const {entries, parseErrors} = await readMemoryEntries(cwd, baseDir);
  warnParseErrors(file, parseErrors);
  return entries.filter(entry =>
    entry.key.toLowerCase().includes(normalizedQuery) ||
    entry.value.toLowerCase().includes(normalizedQuery) ||
    entry.tags.some(tag => tag.includes(normalizedQuery))
  );
}

export async function listMemory(cwd = process.cwd(), baseDir = DEFAULT_MEMORY_DIR): Promise<MemoryEntry[]> {
  const file = memoryFile(cwd, baseDir);
  const {entries, parseErrors} = await readMemoryEntries(cwd, baseDir);
  warnParseErrors(file, parseErrors);
  return entries;
}

export async function clearMemory(cwd = process.cwd(), baseDir = DEFAULT_MEMORY_DIR): Promise<void> {
  const file = memoryFile(cwd, baseDir);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await atomicWriteJsonl(file, []);
}

export async function readMemoryEntries(cwd = process.cwd(), baseDir = DEFAULT_MEMORY_DIR): Promise<ReadMemoryEntriesResult> {
  const file = memoryFile(cwd, baseDir);
  const raw = await fs.readFile(file, 'utf8').catch((error: unknown) => {
    if (isEnoent(error)) return '';
    throw error;
  });
  const entries: MemoryEntry[] = [];
  const parseErrors: string[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as MemoryEntry);
    } catch (error) {
      parseErrors.push(`Line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {entries, parseErrors};
}

export function formatMemoryEntry(entry: MemoryEntry): string {
  const tagPart = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  return `- ${entry.key}${tagPart}: ${entry.value}`;
}

export function formatMemoryList(entries: MemoryEntry[]): string {
  if (entries.length === 0) return 'No memory entries for this workspace.';
  return `${entries.length} workspace memory entr${entries.length === 1 ? 'y' : 'ies'}:\n${entries.map(formatMemoryEntry).join('\n')}`;
}
