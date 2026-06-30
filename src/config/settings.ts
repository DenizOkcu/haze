import fs from 'fs-extra';
import path from 'node:path';
import {HAZE_DIR} from './paths.js';

export interface HazeProviderSettings {
  name: string;
  url: string;
  key?: string;
  models: string[];
}

export interface HazeLspServerSettings {
  name: string;
  command: string;
  args?: string[];
  extensions?: string[];
  rootPatterns?: string[];
  enabled?: boolean;
}

export interface HazeMcpHeader {
  name: string;
  value: string;
}

export interface HazeMcpServer {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: HazeMcpHeader[];
  enabled?: boolean;
}

/**
 * Metadata override for an on-disk skill. The skill directory (~/.haze/skills/<name>)
 * remains the source of truth for existence and content; this index only records
 * overrides. A skill is enabled unless an entry here sets `enabled: false`, mirroring
 * the enable/disable toggle the provider/LSP/MCP pickers expose.
 */
export interface HazeSkillSetting {
  name: string;
  enabled?: boolean;
}

export interface HazeSettings {
  provider?: string;
  model?: string;
  providers?: HazeProviderSettings[];
  lspServers?: HazeLspServerSettings[];
  mcpServers?: HazeMcpServer[];
  skills?: HazeSkillSetting[];
  priceOverrides?: Record<string, {input?: number; output?: number}>;
  budget?: {daily?: number; session?: number; enabled?: boolean};

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
