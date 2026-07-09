import fs from 'fs-extra';
import path from 'node:path';
import {z} from 'zod';
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

  // Legacy OpenRouter-only settings. Still read for compatibility.
  apiKey?: string;
  baseURL?: string;

  // Preserve unknown user/plugin fields when patching settings.
  [key: string]: unknown;
}

export const SETTINGS_FILE = path.join(HAZE_DIR, 'settings.json');

const providerSchema = z.object({
  name: z.string(),
  url: z.string(),
  key: z.string().optional(),
  models: z.array(z.string()),
}).passthrough();

const lspServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  rootPatterns: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
}).passthrough();

const mcpHeaderSchema = z.object({name: z.string(), value: z.string()}).passthrough();
const mcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(['http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  headers: z.array(mcpHeaderSchema).optional(),
  enabled: z.boolean().optional(),
}).passthrough();

const skillSettingSchema = z.object({name: z.string(), enabled: z.boolean().optional()}).passthrough();

const settingsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  providers: z.array(providerSchema).optional(),
  lspServers: z.array(lspServerSchema).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  skills: z.array(skillSettingSchema).optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
}).passthrough();

function settingsReadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to read Haze settings at ${SETTINGS_FILE}: ${message}. Fix or remove the settings file, then retry.`);
}

export async function readSettings(): Promise<HazeSettings> {
  try {
    const raw = await fs.readJson(SETTINGS_FILE);
    return settingsSchema.parse(raw) as HazeSettings;
  } catch (error) {
    const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
    if (code === 'ENOENT') return {};
    throw settingsReadError(error);
  }
}

export async function writeSettings(settings: HazeSettings): Promise<void> {
  await fs.ensureDir(HAZE_DIR);
  const parsed = settingsSchema.parse(settings) as HazeSettings;
  const tempFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeJson(tempFile, parsed, {spaces: 2});
  await fs.move(tempFile, SETTINGS_FILE, {overwrite: true});
}

export async function updateSettings(patch: HazeSettings): Promise<HazeSettings> {
  const next = {...await readSettings(), ...patch};
  await writeSettings(next);
  return next;
}
