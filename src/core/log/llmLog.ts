import path from 'node:path';
import fs from 'fs-extra';
import {HAZE_DIR} from '../../config/paths.js';
import type {ModelMessage} from 'ai';
import type {ContextBreakdown} from '../agent/contextBudget.js';
import {appendPrivateFile, ensurePrivateFile, ensurePrivateDir, tightenPrivateFile} from '../../config/privateStorage.js';
import {OrderedFileWriter} from '../persistence/orderedFileWriter.js';
import {JSONL_LINE_BYTES} from '../limits/byteBudgets.js';
import {iterateBoundedUtf8Lines} from '../io/boundedRead.js';

export interface LlmLogEntry {
  /** ISO timestamp. */
  at: string;
  /** Entry type. */
  type: 'request' | 'response' | 'step' | 'tool_call' | 'tool_result' | 'error' | 'warning';
  /** Which stream this belongs to: 'main' or 'continuation'. */
  stream: string;
  /** Step number within the stream. */
  step?: number;
  /** System prompt sent to the model (request entries only). */
  system?: string;
  /** Messages sent to the model (request entries only). */
  messages?: ModelMessage[];
  /** Tool names available (request entries only). */
  tools?: string[];
  /** Size-only request composition metrics. */
  context?: ContextBreakdown;
  /** Model response text. */
  text?: string;
  /** Finish reason from the model. */
  finishReason?: string;
  /** Token usage from the provider. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
    reasoningTokens?: number;
    logicalInputEstimate?: number;
    effectiveNonCachedInput?: number;
    /** cacheReadTokens / inputTokens. Undefined when either is missing or input is 0. */
    cacheHitRatio?: number;
  };
  /** Tool call details. */
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
  };
  /** Tool result details. */
  toolResult?: {
    id: string;
    name: string;
    success: boolean;
    output?: unknown;
    error?: unknown;
    durationMs?: number;
  };
  /** Error message. */
  error?: string;
}

const LOGS_DIR = path.join(HAZE_DIR, 'logs');

function logFileId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function isSafeLogId(id: string): boolean {
  return id.length > 0 && path.basename(id) === id && path.win32.basename(id) === id;
}

function logFilePath(id: string) {
  return path.join(LOGS_DIR, `${id}.jsonl`);
}

export interface LlmLog {
  id: string;
  file: string;
  writer?: OrderedFileWriter<LlmLogEntry>;
}


export async function createLog(): Promise<LlmLog> {
  await ensurePrivateDir(LOGS_DIR);
  const id = logFileId();
  const file = logFilePath(id);
  await ensurePrivateFile(file);
  const log: LlmLog = {id, file};
  log.writer = new OrderedFileWriter(entry => appendPrivateFile(file, `${JSON.stringify(entry)}\n`));
  return log;
}

export async function appendLogEntry(log: LlmLog, entry: LlmLogEntry): Promise<void> {
  if (log.writer) {
    await log.writer.append(entry);
    return;
  }
  await appendPrivateFile(log.file, `${JSON.stringify(entry)}\n`);
}

export async function endLog(log: LlmLog): Promise<void> {
  const entry: LlmLogEntry = {
    at: new Date().toISOString(),
    type: 'response',
    stream: 'main',
    finishReason: 'log-ended',
  };
  await appendLogEntry(log, entry);
  await log.writer?.close();
}

export async function listLogs(): Promise<Array<{id: string; file: string; size: number; modified: string}>> {
  await ensurePrivateDir(LOGS_DIR);
  const files = await fs.readdir(LOGS_DIR);
  const logs: Array<{id: string; file: string; size: number; modified: string}> = [];
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(LOGS_DIR, name);
    const stat = await fs.stat(file);
    logs.push({id: name.replace(/\.jsonl$/, ''), file, size: stat.size, modified: stat.mtime.toISOString()});
  }
  return logs.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function readLogEntries(id: string): Promise<LlmLogEntry[]> {
  if (!isSafeLogId(id)) return [];
  const file = logFilePath(id);
  const entries: LlmLogEntry[] = [];
  try {
    await tightenPrivateFile(file);
    for await (const {line, oversized} of iterateBoundedUtf8Lines(file, JSONL_LINE_BYTES)) {
      if (!line || oversized) continue;
      try { entries.push(JSON.parse(line) as LlmLogEntry); } catch { /* isolate malformed lines */ }
    }
  } catch { return []; }
  return entries;
}

export interface LlmLogSummary {
  entries: number;
  typeCounts: Record<string, number>;
  totalInput: number;
  totalOutput: number;
  toolCallCounts: Record<string, number>;
}

export async function summarizeLog(id: string): Promise<LlmLogSummary | undefined> {
  if (!isSafeLogId(id)) return undefined;
  const file = logFilePath(id);
  const summary: LlmLogSummary = {entries: 0, typeCounts: {}, totalInput: 0, totalOutput: 0, toolCallCounts: {}};
  try {
    await tightenPrivateFile(file);
    for await (const {line, oversized} of iterateBoundedUtf8Lines(file, JSONL_LINE_BYTES)) {
      if (!line || oversized) continue;
      let entry: LlmLogEntry;
      try { entry = JSON.parse(line) as LlmLogEntry; } catch { continue; }
      summary.entries++;
      summary.typeCounts[entry.type] = (summary.typeCounts[entry.type] ?? 0) + 1;
      summary.totalInput += entry.usage?.inputTokens ?? 0;
      summary.totalOutput += entry.usage?.outputTokens ?? 0;
      if (entry.type === 'tool_call' && entry.toolCall) {
        summary.toolCallCounts[entry.toolCall.name] = (summary.toolCallCounts[entry.toolCall.name] ?? 0) + 1;
      }
    }
  } catch { return undefined; }
  return summary.entries > 0 ? summary : undefined;
}
