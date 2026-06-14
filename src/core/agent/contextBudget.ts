import {z} from 'zod';
import type {ModelMessage} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';

export const DEFAULT_CHARS_PER_TOKEN = 4;

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

export function estimateValueTokens(value: unknown) {
  if (typeof value === 'string') return estimateTextTokens(value);
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
