import path from 'node:path';
import fs from 'fs-extra';
import {HAZE_DIR} from '../../config/paths.js';
import {costForUsage, priceForModel} from './pricing.js';
import type {TokenUsage} from '../../cli/commands/streaming.js';
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

function dateFileId(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function filePath(date = new Date(), baseDir = HAZE_DIR) {
  return path.join(usageDir(baseDir), `${dateFileId(date)}.jsonl`);
}

export async function appendUsageEntry(
  config: ModelRuntimeConfig,
  usage: TokenUsage,
  options?: {sessionStart?: Date; baseDir?: string; date?: Date},
): Promise<void> {
  const price = await priceForModel(config.providerName, config.modelName);
  const cost = price ? costForUsage(usage, price) : undefined;
  const entry: UsageLedgerEntry = {
    ts: new Date().toISOString(),
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
  const file = filePath(options?.date ?? new Date(), options?.baseDir);
  await fs.ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
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
