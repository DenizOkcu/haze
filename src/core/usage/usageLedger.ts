import path from 'node:path';
import fs from 'fs-extra';
import {HAZE_DIR} from '../../config/paths.js';
import {costForUsage, priceForModel} from './pricing.js';
import type {TokenUsage} from './types.js';
import type {ModelRuntimeConfig} from '../../llm/client.js';

export interface UsageLedgerEntry {
  ts: string;
  sessionStart?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost?: number;
}

export function usageDir(baseDir = HAZE_DIR) {
  return path.join(baseDir, 'usage');
}

const corruptedLedgerFiles = new Set<string>();

export function getCorruptedLedgerFiles(): string[] {
  return [...corruptedLedgerFiles];
}

export function clearCorruptedLedgerFiles(): void {
  corruptedLedgerFiles.clear();
}

function dateFileId(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function filePath(date = new Date(), baseDir = HAZE_DIR) {
  return path.join(usageDir(baseDir), `${dateFileId(date)}.jsonl`);
}

const writeQueues = new Map<string, Promise<unknown>>();

async function queuedWrite(file: string, line: string): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    await fs.ensureDir(path.dirname(file));
    const tmpFile = path.join(path.dirname(file), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    await fs.writeFile(tmpFile, line, 'utf8');
    try {
      await fs.appendFile(file, await fs.readFile(tmpFile, 'utf8'), 'utf8');
    } finally {
      await fs.remove(tmpFile).catch(() => undefined);
    }
  });
  writeQueues.set(file, next.catch(() => undefined));
  await next;
}

export async function appendUsageEntry(
  config: ModelRuntimeConfig,
  usage: TokenUsage,
  options?: {sessionStart?: Date; baseDir?: string; date?: Date},
): Promise<void> {
  const now = options?.date ?? new Date();
  const price = await priceForModel(config.providerName, config.modelName);
  const cost = price ? costForUsage(usage, price) : undefined;
  const entry: UsageLedgerEntry = {
    ts: now.toISOString(),
    sessionStart: options?.sessionStart?.toISOString(),
    provider: config.providerName,
    model: config.modelName,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    ...(cost != null ? {cost} : {}),
  };
  const file = filePath(now, options?.baseDir);
  await queuedWrite(file, `${JSON.stringify(entry)}\n`);
}

export async function readUsageEntries(options?: {date?: Date; baseDir?: string}): Promise<UsageLedgerEntry[]> {
  const file = filePath(options?.date ?? new Date(), options?.baseDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    console.error(`Failed to read usage ledger ${file}: ${error}`);
    throw error;
  }
  return raw.split('\n').filter(Boolean).flatMap((line, index) => {
    try {
      return [JSON.parse(line) as UsageLedgerEntry];
    } catch {
      corruptedLedgerFiles.add(file);
      console.error(`Malformed usage ledger line ${index + 1} in ${file}: ${line.slice(0, 120)}`);
      return [];
    }
  });
}

export async function readUsageRange(days: number, options?: {now?: Date; baseDir?: string}): Promise<UsageLedgerEntry[]> {
  const now = options?.now ?? new Date();
  const entries: UsageLedgerEntry[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - i);
    entries.push(...await readUsageEntries({date, baseDir: options?.baseDir}));
  }
  return entries;
}
