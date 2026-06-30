import type {HazeMcpServer, HazeSettings} from './settings.js';
import {findByName, removeByName, upsertByName} from '../utils/collections.js';

export type McpTransport = 'http' | 'sse' | 'stdio';

const TRANSPORTS: readonly McpTransport[] = ['http', 'sse', 'stdio'];

/**
 * Presets for well-known MCP servers. Keys are stable preset identifiers users
 * can select from the `/mcp add` flow. Omit `name`; it is supplied by the caller.
 */
export const MCP_PRESETS: Record<string, Omit<HazeMcpServer, 'name'> & {description?: string}> = {
  context7: {transport: 'http', url: 'https://mcp.context7.com/mcp', description: 'Context7 — up-to-date library docs'},
};

export function presetIds(): string[] {
  return Object.keys(MCP_PRESETS);
}

export function findMcpPreset(id: string): (Omit<HazeMcpServer, 'name'> & {description?: string}) | undefined {
  return MCP_PRESETS[id];
}

export function isTransport(value: unknown): value is McpTransport {
  return typeof value === 'string' && (TRANSPORTS as readonly string[]).includes(value);
}

function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const result = values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(result)];
}

function normalizeHeaders(headers: unknown): HazeMcpServer['headers'] | undefined {
  if (!Array.isArray(headers)) return undefined;
  const result: {name: string; value: string}[] = [];
  for (const header of headers) {
    if (typeof header !== 'object' || header == null) continue;
    const candidate = header as {name?: unknown; value?: unknown};
    if (typeof candidate.name !== 'string' || typeof candidate.value !== 'string') continue;
    const name = candidate.name.trim();
    if (!name) continue;
    result.push({name, value: candidate.value});
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Normalize and validate an MCP server definition. Returns undefined when the
 * definition is missing required fields for its transport.
 */
export function normalizeServer(server: HazeMcpServer): HazeMcpServer | undefined {
  const name = server.name?.trim();
  const transport = isTransport(server.transport) ? server.transport : undefined;
  if (!name || !transport) return undefined;

  if (transport === 'http' || transport === 'sse') {
    const url = server.url?.trim();
    if (!url) return undefined;
    const headers = normalizeHeaders(server.headers);
    return {
      name,
      transport,
      url,
      ...(headers ? {headers} : {}),
      ...(server.enabled === false ? {enabled: false} : {}),
    };
  }

  // stdio
  const command = server.command?.trim();
  if (!command) return undefined;
  const args = normalizeStringArray(server.args);
  return {
    name,
    transport,
    command,
    ...(args && args.length > 0 ? {args} : {}),
    ...(server.enabled === false ? {enabled: false} : {}),
  };
}

/**
 * Validate a raw MCP server entry and return a human-readable error reason, or
 * undefined if the entry is valid. This checks the same rules normalizeServer
 * uses, but surfaces why an entry would be dropped.
 */
export function mcpServerValidationError(server: HazeMcpServer): string | undefined {
  const name = server.name?.trim();
  const transport = isTransport(server.transport) ? server.transport : undefined;
  if (!name) return 'missing server name';
  if (!transport) return `invalid transport "${String(server.transport)}"`;
  if (transport === 'http' || transport === 'sse') {
    if (!server.url?.trim()) return 'missing URL';
  } else {
    if (!server.command?.trim()) return 'missing command';
  }
  return undefined;
}

export function configuredMcpServers(settings: HazeSettings): HazeMcpServer[] {
  return (settings.mcpServers ?? [])
    .map(server => normalizeServer(server))
    .filter((server): server is HazeMcpServer => Boolean(server));
}

export function findMcpServer(settings: HazeSettings, name: string): HazeMcpServer | undefined {
  return findByName(configuredMcpServers(settings), name);
}

export function upsertMcpServer(settings: HazeSettings, server: HazeMcpServer): HazeMcpServer[] {
  return upsertByName(configuredMcpServers(settings), server);
}

export function removeMcpServer(settings: HazeSettings, name: string): HazeMcpServer[] {
  return removeByName(configuredMcpServers(settings), name);
}

export function toggleMcpServer(settings: HazeSettings, name: string, enabled: boolean): HazeMcpServer[] | undefined {
  const servers = configuredMcpServers(settings);
  const target = findByName(servers, name);
  if (!target) return undefined;
  return upsertMcpServer(settings, {...target, enabled});
}
