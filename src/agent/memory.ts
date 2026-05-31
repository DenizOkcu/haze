import fs from 'fs-extra';
import path from 'node:path';
import {MEMORY_FILE} from '../config/paths.js';

interface Memory { recentRuns: {timestamp: string; request: string; summary: string}[] }

export async function addMemory(request: string, summary: string) {
  await fs.ensureDir(path.dirname(MEMORY_FILE));
  const memory: Memory = await fs.readJson(MEMORY_FILE).catch(() => ({recentRuns: []}));
  memory.recentRuns.unshift({timestamp: new Date().toISOString(), request, summary});
  memory.recentRuns = memory.recentRuns.slice(0, 20);
  await fs.writeJson(MEMORY_FILE, memory, {spaces: 2});
}
