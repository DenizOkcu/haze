import fs from 'fs-extra';
import path from 'node:path';
import {z} from 'zod';
import {HAZE_DIR} from './paths.js';
import {tightenPrivateFile, writePrivateJsonAtomic} from './privateStorage.js';
import {customProfileSchema} from '../core/subagent/executionProfiles.js';
import type {ModelPricing} from '../core/agent/costAccounting.js';

/** Optional, explicitly user-controlled reasoning depth (provider/protocol gated). */
export type ReasoningLevel = 'low' | 'medium' | 'high';
export const reasoningLevelSchema = z.enum(['low', 'medium', 'high']);

export interface HazeProviderSettings {
  name: string;
  url: string;
  key?: string;
  models: string[];
  /** Explicit runtime/auth protocol. Omitted means a normal OpenAI-compatible endpoint. */
  kind?: 'openai-compatible' | 'chatgpt-codex';
  /**
   * Explicit endpoint capabilities. Never inferred: images are only sent to
   * providers the user marked image-capable (F03).
   */
  capabilities?: {images?: boolean};
  /**
   * Optional per-model capacity metadata used for request budgeting (RH-005).
   * Absent entries fall back to a conservative default window. Preserved as
   * passthrough so unknown metadata is not dropped. `pricing` (USD per 1M
   * tokens) feeds the optional cost estimate (F-12).
   */
  modelLimits?: Record<string, {contextWindowTokens?: number; maxOutputTokens?: number; pricing?: ModelPricing}>;
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
  /** Omitted by older settings and interpreted as global. */
  scope?: 'global' | 'project';
  enabled?: boolean;
}

export interface HazeSubagentSettings {
  workerModel?: string;
  defaultProfile?: string;
  profiles?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface HazeSettings {
  provider?: string;
  model?: string;
  providers?: HazeProviderSettings[];
  lspServers?: HazeLspServerSettings[];
  mcpServers?: HazeMcpServer[];
  skills?: HazeSkillSetting[];
  subagents?: HazeSubagentSettings;
  /** Optional reasoning depth; unset by default, mapped by supported provider protocol. */
  reasoning?: ReasoningLevel;
  /**
   * Context-window fallback for models without `modelLimits` metadata, in
   * tokens. Unset means the built-in default (128K hosted / 32K local —
   * see `contextBudget.ts`). The local variant applies to localhost inference
   * servers, whose effective window is server-configured and silently truncated.
   */
  contextWindowFallbackTokens?: number;
  localContextWindowFallbackTokens?: number;
  /** UI tweaks: rotating tips under the busy label, etc. Default enabled. */
  tips?: {enabled?: boolean};

  // Legacy OpenRouter-only settings. Still read for compatibility.
  apiKey?: string;
  baseURL?: string;

  // Preserve unknown user/plugin fields when patching settings.
  [key: string]: unknown;
}

export const SETTINGS_FILE = path.join(HAZE_DIR, 'settings.json');

const providerCapabilitiesSchema = z.object({
  images: z.boolean().optional(),
}).passthrough();

const modelPricingSchema = z.object({
  inputPerMillionTokens: z.number().positive(),
  outputPerMillionTokens: z.number().positive(),
  cacheReadPerMillionTokens: z.number().positive().optional(),
  cacheWritePerMillionTokens: z.number().positive().optional(),
});

const providerSchema = z.object({
  name: z.string(),
  url: z.string(),
  key: z.string().optional(),
  models: z.array(z.string()),
  kind: z.enum(['openai-compatible', 'chatgpt-codex']).optional(),
  capabilities: providerCapabilitiesSchema.optional(),
  modelLimits: z.record(z.string(), z.object({contextWindowTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(), pricing: modelPricingSchema}).partial()).optional(),
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

const skillSettingSchema = z.object({name: z.string(), scope: z.enum(['global', 'project']).optional(), enabled: z.boolean().optional()}).passthrough();
const subagentSettingsSchema = z.object({
  workerModel: z.string().trim().min(1).optional(),
  defaultProfile: z.string().trim().min(1).optional(),
  profiles: z.record(z.string().min(1), customProfileSchema).optional(),
}).passthrough();

/** Fallback windows must be plausible positive token counts (not fractions/junk). */
const contextWindowFallbackSchema = z.number().int().min(1_000).max(10_000_000);

const settingsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  providers: z.array(providerSchema).optional(),
  lspServers: z.array(lspServerSchema).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  skills: z.array(skillSettingSchema).optional(),
  subagents: subagentSettingsSchema.optional(),
  reasoning: reasoningLevelSchema.optional(),
  contextWindowFallbackTokens: contextWindowFallbackSchema.optional(),
  localContextWindowFallbackTokens: contextWindowFallbackSchema.optional(),
  tips: z.object({enabled: z.boolean().optional()}).optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
}).passthrough();

function settingsReadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to read Haze settings at ${SETTINGS_FILE}: ${message}. Fix or remove the settings file, then retry.`);
}

export async function readSettings(): Promise<HazeSettings> {
  try {
    if (await fs.pathExists(SETTINGS_FILE)) await tightenPrivateFile(SETTINGS_FILE);
    const raw = await fs.readJson(SETTINGS_FILE);
    return settingsSchema.parse(raw) as HazeSettings;
  } catch (error) {
    const code = typeof error === 'object' && error != null && 'code' in error ? (error as {code?: unknown}).code : undefined;
    if (code === 'ENOENT') return {};
    throw settingsReadError(error);
  }
}

export async function writeSettings(settings: HazeSettings): Promise<void> {
  const parsed = settingsSchema.parse(settings) as HazeSettings;
  await writePrivateJsonAtomic(SETTINGS_FILE, parsed);
}

export async function updateSettings(patch: HazeSettings): Promise<HazeSettings> {
  const next = {...await readSettings(), ...patch};
  await writeSettings(next);
  return next;
}

/** Patch subagent settings without dropping unknown nested/profile fields. */
export async function updateSubagentSettings(patch: HazeSubagentSettings): Promise<HazeSettings> {
  const current = await readSettings();
  const currentSubagents = current.subagents ?? {};
  const profiles = patch.profiles
    ? Object.fromEntries(Object.entries(patch.profiles).map(([name, value]) => [name, {...(currentSubagents.profiles?.[name] ?? {}), ...value}]))
    : undefined;
  const subagents: HazeSubagentSettings = {
    ...currentSubagents,
    ...patch,
    ...(profiles ? {profiles: {...(currentSubagents.profiles ?? {}), ...profiles}} : {}),
  };
  const next = {...current, subagents};
  await writeSettings(next);
  return next;
}
