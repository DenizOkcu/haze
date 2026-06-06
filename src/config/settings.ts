import fs from 'fs-extra';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

export interface HazeProviderSettings {
  name: string;
  url: string;
  key?: string;
  models: string[];
}

export interface HazeSettings {
  provider?: string;
  model?: string;
  providers?: HazeProviderSettings[];

  // Legacy OpenRouter-only settings. Still read for compatibility.
  apiKey?: string;
  baseURL?: string;
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
