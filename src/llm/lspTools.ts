import path from 'node:path';
import {tool} from 'ai';
import {z} from 'zod';
import {readSettings} from '../config/settings.js';
import {configuredLspServers} from '../config/lspSettings.js';
import {lspDefinition, lspDiagnostics, lspDocumentSymbols, lspImplementation, lspReferences, lspTypeDefinition, lspWorkspaceSymbols, pickLspServer, type LspPool} from './lsp.js';

async function serverFor(filePath: string) {
  const servers = configuredLspServers(await readSettings()).filter(server => server.enabled !== false);
  return pickLspServer(servers, filePath);
}

function noServer(filePath: string) {
  return {ok: false, error: `No enabled LSP server configured for ${path.extname(filePath) || 'this file type'}. Use /lsp presets and /lsp add <preset> to configure one.`};
}

async function namedOrFirstServer(name?: string) {
  const servers = configuredLspServers(await readSettings()).filter(server => server.enabled !== false);
  if (name) return servers.find(server => server.name === name);
  return servers[0];
}

function cleanLspError(message: string) {
  if (/No Project/i.test(message)) return 'LSP server reported no project for workspace-symbol search. Use grep/listFiles to find likely files, then try file-scoped lspSymbols on those files; fall back to readFile when needed.';
  return message
    .split('\n')
    .filter(line => line.trim() && !/^\s*at\s/.test(line))
    .slice(0, 2)
    .join('\n');
}

function lspFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {ok: false, error: cleanLspError(message)};
}

export const lspTools = buildLspTools();
export type LspTools = typeof lspTools;

/**
 * Build the LSP tool set bound to a shared turn-scoped client pool so repeated
 * symbols/definition/references calls reuse one initialized server and its
 * opened documents instead of paying startup + indexing per call (RH-009).
 */
export function buildLspTools(pool?: LspPool) {
  return {
    lspWorkspaceSymbols: tool({
      description: 'Use a configured language server to search workspace symbols by name. Read-only. Best first LSP tool when the user names a function/class but you do not yet have a precise reference position. If this fails with no project or returns empty, use grep/listFiles to find candidate files, then lspSymbols on those files.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Symbol name or prefix to search for'),
        server: z.string().optional().describe('Optional configured LSP server name. If omitted, the first enabled server is used.'),
        maxSymbols: z.number().int().positive().max(100).default(50).describe('Maximum symbols to return'),
      }),
      execute: async ({query, server: serverName, maxSymbols}) => {
        const server = await namedOrFirstServer(serverName);
        if (!server) return {ok: false, error: serverName ? `No enabled LSP server named ${serverName}.` : 'No enabled LSP server configured. Use /lsp add <preset>.'};
        try {
          const symbols = await lspWorkspaceSymbols(server, query, maxSymbols, pool);
          return {ok: true, server: server.name, query, symbols, truncated: symbols.length >= maxSymbols};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),

    lspSymbols: tool({
      description: 'Use a configured language server to list semantic symbols in a source file. Read-only. Use this after grep/listFiles identifies a likely file, especially when workspace symbol search fails or is not indexed.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Workspace-relative source file path'),
        maxSymbols: z.number().int().positive().max(200).default(80).describe('Maximum symbols to return'),
      }),
      execute: async ({path: filePath, maxSymbols}) => {
        const server = await serverFor(filePath);
        if (!server) return noServer(filePath);
        try {
          const symbols = await lspDocumentSymbols(server, filePath, maxSymbols, pool);
          return {ok: true, server: server.name, path: filePath, symbols, truncated: symbols.length >= maxSymbols};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),

    lspDefinition: tool({
      description: 'Use a configured language server to find the definition at a 1-based line/column in a source file. Read-only.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Workspace-relative source file path'),
        line: z.number().int().positive().describe('1-based line number'),
        column: z.number().int().positive().describe('1-based column/character number'),
        maxResults: z.number().int().positive().max(50).default(20).describe('Maximum locations to return'),
      }),
      execute: async ({path: filePath, line, column, maxResults}) => {
        const server = await serverFor(filePath);
        if (!server) return noServer(filePath);
        try {
          const locations = await lspDefinition(server, filePath, line, column, maxResults, pool);
          return {ok: true, server: server.name, path: filePath, locations, truncated: locations.length >= maxResults};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),

    lspReferences: tool({
      description: 'Use a configured language server to find references at a 1-based line/column in a source file. Read-only.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Workspace-relative source file path'),
        line: z.number().int().positive().describe('1-based line number'),
        column: z.number().int().positive().describe('1-based column/character number'),
        maxResults: z.number().int().positive().max(100).default(50).describe('Maximum locations to return'),
      }),
      execute: async ({path: filePath, line, column, maxResults}) => {
        const server = await serverFor(filePath);
        if (!server) return noServer(filePath);
        try {
          const locations = await lspReferences(server, filePath, line, column, maxResults, pool);
          return {ok: true, server: server.name, path: filePath, locations, truncated: locations.length >= maxResults};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),

    lspTypeDefinition: tool({
      description: 'Use a configured language server to find the type definition (e.g. interface, type alias, class) for the symbol at a 1-based line/column. Read-only. Useful for generics and annotated values where lspDefinition lands on the annotated name instead of its type.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Workspace-relative source file path'),
        line: z.number().int().positive().describe('1-based line number'),
        column: z.number().int().positive().describe('1-based column/character number'),
        maxResults: z.number().int().positive().max(50).default(20).describe('Maximum locations to return'),
      }),
      execute: async ({path: filePath, line, column, maxResults}) => {
        const server = await serverFor(filePath);
        if (!server) return noServer(filePath);
        try {
          const locations = await lspTypeDefinition(server, filePath, line, column, maxResults, pool);
          return {ok: true, server: server.name, path: filePath, locations, truncated: locations.length >= maxResults};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),

    lspImplementation: tool({
      description: 'Use a configured language server to find implementations of an interface, abstract member, or generic signature at a 1-based line/column. Read-only.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Workspace-relative source file path'),
        line: z.number().int().positive().describe('1-based line number'),
        column: z.number().int().positive().describe('1-based column/character number'),
        maxResults: z.number().int().positive().max(100).default(50).describe('Maximum locations to return'),
      }),
      execute: async ({path: filePath, line, column, maxResults}) => {
        const server = await serverFor(filePath);
        if (!server) return noServer(filePath);
        try {
          const locations = await lspImplementation(server, filePath, line, column, maxResults, pool);
          return {ok: true, server: server.name, path: filePath, locations, truncated: locations.length >= maxResults};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),

    lspDiagnostics: tool({
      description: 'Use a configured language server to get diagnostics (errors/warnings) for one source file. Read-only. Best for a quick post-edit check of a single touched file; prefer the relevant build/test command for authoritative whole-project validation.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Workspace-relative source file path'),
        maxResults: z.number().int().positive().max(100).default(50).describe('Maximum diagnostics to return'),
      }),
      execute: async ({path: filePath, maxResults}) => {
        const server = await serverFor(filePath);
        if (!server) return noServer(filePath);
        try {
          const result = await lspDiagnostics(server, filePath, maxResults, pool);
          if (!result.ok) return {ok: false, error: result.error};
          return {ok: true, server: server.name, path: filePath, diagnostics: result.diagnostics, truncated: result.diagnostics.length >= maxResults};
        } catch (error) {
          return lspFailure(error);
        }
      },
    }),
  };
}
