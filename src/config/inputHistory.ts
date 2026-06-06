import fs from 'fs-extra';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

const HISTORY_DIR = path.join(HAZE_DIR, 'history');
export const INPUT_HISTORY_FILE = path.join(HISTORY_DIR, 'input-history.json');
const MAX_HISTORY_ITEMS = 500;
const DISABLE_PERSISTENT_HISTORY = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
let testHistory: string[] = [];

function normalizeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export async function readInputHistory(): Promise<string[]> {
  if (DISABLE_PERSISTENT_HISTORY) return testHistory.slice(-MAX_HISTORY_ITEMS);
  const data = await fs.readJson(INPUT_HISTORY_FILE).catch(() => []);
  return normalizeHistory(data).slice(-MAX_HISTORY_ITEMS);
}

export async function writeInputHistory(history: string[]): Promise<void> {
  const normalized = normalizeHistory(history).slice(-MAX_HISTORY_ITEMS);
  if (DISABLE_PERSISTENT_HISTORY) {
    testHistory = normalized;
    return;
  }
  await fs.ensureDir(HISTORY_DIR);
  await fs.writeJson(INPUT_HISTORY_FILE, normalized, {spaces: 2});
}

export async function addInputHistoryItem(item: string): Promise<string[]> {
  const trimmed = item.trim();
  if (!trimmed) return readInputHistory();
  const current = await readInputHistory();
  const next = current[current.length - 1] === trimmed ? current : [...current, trimmed];
  await writeInputHistory(next);
  return next.slice(-MAX_HISTORY_ITEMS);
}
