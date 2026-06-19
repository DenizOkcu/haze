import path from 'node:path';
import fs from 'fs-extra';
import {HAZE_DIR} from '../../config/paths.js';
import type {ModelMessage} from 'ai';
import type {ContextBreakdown} from '../agent/contextBudget.js';

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

function logFilePath(id: string) {
  return path.join(LOGS_DIR, `${id}.jsonl`);
}

export interface LlmLog {
  id: string;
  file: string;
}


export async function createLog(): Promise<LlmLog> {
  await fs.ensureDir(LOGS_DIR);
  const id = logFileId();
  const file = logFilePath(id);
  await fs.writeFile(file, '');
  return {id, file};
}

export async function appendLogEntry(log: LlmLog, entry: LlmLogEntry): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(log.file, line);
}

export async function endLog(log: LlmLog): Promise<void> {
  const entry: LlmLogEntry = {
    at: new Date().toISOString(),
    type: 'response',
    stream: 'main',
    finishReason: 'log-ended',
  };
  await appendLogEntry(log, entry);
}

export async function listLogs(): Promise<Array<{id: string; file: string; size: number; modified: string}>> {
  await fs.ensureDir(LOGS_DIR);
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
  const file = logFilePath(id);
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line) as LlmLogEntry];
    } catch {
      return [];
    }
  });
}
