import fs from 'fs-extra';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

export interface HazeSettings {
  provider?: 'openrouter';
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export const SETTINGS_FILE = path.join(HAZE_DIR, 'settings.json');

export async function readSettings(): Promise<HazeSettings> {
  return fs.readJson(SETTINGS_FILE).catch(() => ({}));
}

export async function writeSettings(settings: HazeSettings): Promise<void> {
  await fs.ensureDir(HAZE_DIR);
  await fs.writeJson(SETTINGS_FILE, settings, {spaces: 2});
}

export async function updateSettings(patch: HazeSettings): Promise<HazeSettings> {
  const next = {...await readSettings(), ...patch};
  await writeSettings(next);
  return next;
}
