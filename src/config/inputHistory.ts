import fs from 'fs-extra';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';
import {tightenPrivateFile, writePrivateJsonAtomic} from './privateStorage.js';

const HISTORY_DIR = path.join(HAZE_DIR, 'history');
const INPUT_HISTORY_FILE = path.join(HISTORY_DIR, 'input-history.json');
const MAX_HISTORY_ITEMS = 500;

function normalizeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

// The storage path is injectable so tests isolate via temp files instead of
// production switches on test-env globals (CR-011).
export async function readInputHistory(file = INPUT_HISTORY_FILE): Promise<string[]> {
  if (await fs.pathExists(file)) await tightenPrivateFile(file);
  const data = await fs.readJson(file).catch(() => []);
  return normalizeHistory(data).slice(-MAX_HISTORY_ITEMS);
}

export async function writeInputHistory(history: string[], file = INPUT_HISTORY_FILE): Promise<void> {
  const normalized = normalizeHistory(history).slice(-MAX_HISTORY_ITEMS);
  await writePrivateJsonAtomic(file, normalized);
}

export async function addInputHistoryItem(item: string, file = INPUT_HISTORY_FILE): Promise<string[]> {
  const trimmed = item.trim();
  if (!trimmed) return readInputHistory(file);
  const current = await readInputHistory(file);
  const next = current[current.length - 1] === trimmed ? current : [...current, trimmed];
  await writeInputHistory(next, file);
  return next.slice(-MAX_HISTORY_ITEMS);
}
