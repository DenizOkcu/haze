import {z} from 'zod';
import type {ModelMessage} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';
import {imageFilePartBytes, isImageFilePart} from '../attachments/imageAttachments.js';

export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Conservative fallback context window when a provider/model carries no
 * explicit metadata (RH-005). Chosen small enough that small local models do
 * not overflow on first request; large-context models should declare their
 * capacity via provider `modelLimits`.
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_768;

/** Safety margin reserved below the computed budget to absorb estimate drift. */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 1_000;

/**
 * Rough vision estimate for attached images: providers bill images by
 * resolution, not by serialized bytes. ~750 bytes per token matches common
 * screenshot encodings closely enough for budget/display estimates. Labeled
 * as an estimate wherever it surfaces.
 */
export const IMAGE_BYTES_PER_TOKEN_ESTIMATE = 750;

export interface ContextBreakdown {
  logicalInputEstimate: number;
  system: number;
  projectContext: Array<{path: string; tokens: number}>;
  toolSchemas: Array<{name: string; tokens: number}>;
  messagesByRole: Record<string, number>;
  toolInputs: Record<string, number>;
  toolResults: Record<string, number>;
  syntheticControl: number;
}

export function estimateTextTokens(text: string) {
  return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);
}

export function estimateImagePartTokens(part: unknown) {
  if (!isImageFilePart(part)) return 0;
  const bytes = imageFilePartBytes(part.data);
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / IMAGE_BYTES_PER_TOKEN_ESTIMATE)) : 1;
}

export function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTextTokens(value);
  // Image parts are estimated from their byte size; serializing megabytes of
  // image data as JSON would blow up both memory and the token estimate.
  if (isImageFilePart(value)) return estimateImagePartTokens(value);
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + estimateValueTokens(item), 0);
  if (typeof value === 'object' && value != null && Array.isArray((value as {content?: unknown}).content)) {
    const message = value as Record<string, unknown>;
    const envelope: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(message)) if (key !== 'content') envelope[key] = item;
    return estimateTextTokens(JSON.stringify(envelope))
      + (message.content as unknown[]).reduce<number>((sum, part) => sum + estimateValueTokens(part), 0);
  }
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}

function toolSchemaText(toolValue: unknown) {
  if (typeof toolValue !== 'object' || toolValue == null) return '';
  const value = toolValue as {description?: unknown; inputSchema?: unknown};
  let schema: unknown = value.inputSchema;
  try {
    schema = z.toJSONSchema(value.inputSchema as Parameters<typeof z.toJSONSchema>[0]);
  } catch {
    // Provider-neutral fallback for non-Zod schemas.
  }
  return JSON.stringify({
    description: typeof value.description === 'string' ? value.description : undefined,
    inputSchema: schema,
  });
}

export function estimateToolSchemas(tools: Record<string, unknown> = {}) {
  return Object.entries(tools).map(([name, value]) => ({
    name,
    tokens: estimateTextTokens(toolSchemaText(value)),
  }));
}

function contentParts(message: ModelMessage) {
  return Array.isArray(message.content) ? message.content : [];
}

function partType(part: unknown) {
  return typeof part === 'object' && part != null && 'type' in part && typeof part.type === 'string'
    ? part.type
    : undefined;
}

function toolName(part: unknown) {
  if (typeof part !== 'object' || part == null) return 'unknown';
  if ('toolName' in part && typeof part.toolName === 'string') return part.toolName;
  return 'unknown';
}

export function contextBreakdown(input: {
  system: string;
  contextFiles?: ContextFile[];
  messages: ModelMessage[];
  tools?: Record<string, unknown>;
}): ContextBreakdown {
  const projectContext = (input.contextFiles ?? []).map(file => ({path: file.path, tokens: estimateTextTokens(file.content)}));
  const toolSchemas = estimateToolSchemas(input.tools);
  const messagesByRole: Record<string, number> = {};
  const toolInputs: Record<string, number> = {};
  const toolResults: Record<string, number> = {};
  let syntheticControl = 0;

  for (const message of input.messages) {
    const tokens = estimateValueTokens(message);
    messagesByRole[message.role] = (messagesByRole[message.role] ?? 0) + tokens;
    if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<haze_control>')) {
      syntheticControl += tokens;
    }
    for (const part of contentParts(message)) {
      const type = partType(part);
      const name = toolName(part);
      if (type === 'tool-call') toolInputs[name] = (toolInputs[name] ?? 0) + estimateValueTokens(part);
      if (type === 'tool-result') toolResults[name] = (toolResults[name] ?? 0) + estimateValueTokens(part);
    }
  }

  const system = estimateTextTokens(input.system);
  const logicalInputEstimate = system
    + Object.values(messagesByRole).reduce((sum, tokens) => sum + tokens, 0)
    + toolSchemas.reduce((sum, tool) => sum + tool.tokens, 0);

  return {logicalInputEstimate, system, projectContext, toolSchemas, messagesByRole, toolInputs, toolResults, syntheticControl};
}

export function effectiveNonCachedInput(inputTokens: number | undefined, cacheReadTokens: number) {
  return inputTokens == null ? undefined : Math.max(0, inputTokens - cacheReadTokens);
}

export function cacheHitRatio(inputTokens: number | undefined, cacheReadTokens: number | undefined) {
  if (!inputTokens || !cacheReadTokens) return undefined;
  return cacheReadTokens / inputTokens;
}

export interface RequestTokenBudget {
  contextWindowTokens: number;
  systemTokens: number;
  toolSchemaTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  /** Tokens available for the message history. */
  messageTokens: number;
}

/**
 * Compute the message-token allowance for a request from the full input
 * breakdown: context window minus system prompt, tool schemas, output reserve,
 * and a safety margin (RH-005). Falls back to a conservative window when a
 * model declares no capacity metadata.
 */
export function calculateRequestTokenBudget(input: {
  contextWindowTokens?: number;
  requestedOutputTokens: number;
  system: string;
  tools: Record<string, unknown>;
}): RequestTokenBudget {
  const contextWindowTokens = input.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  const systemTokens = estimateTextTokens(input.system);
  const toolSchemaTokens = estimateToolSchemas(input.tools).reduce((sum, tool) => sum + tool.tokens, 0);
  const outputReserveTokens = input.requestedOutputTokens;
  const safetyMarginTokens = CONTEXT_SAFETY_MARGIN_TOKENS;
  const messageTokens = Math.max(0, contextWindowTokens - systemTokens - toolSchemaTokens - outputReserveTokens - safetyMarginTokens);
  return {contextWindowTokens, systemTokens, toolSchemaTokens, outputReserveTokens, safetyMarginTokens, messageTokens};
}
