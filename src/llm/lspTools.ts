import path from 'node:path';
import {tool} from 'ai';
import {z} from 'zod';
import {readSettings} from '../config/settings.js';
import {configuredLspServers} from '../config/lspSettings.js';
import {pickLspServer, type LspPool} from './lsp/pool.js';
import {lspDefinition, lspDiagnostics, lspDiagnosticsForSymbol, lspDocumentSymbols, lspFindSymbols, lspImplementation, lspReferenceLocations, lspReferences, lspRename, lspTypeDefinition, lspWorkspaceSymbols} from './lsp/requests.js';
import {applyWorkspaceEdit} from './lsp/workspaceEdit.js';
import {hazeToolContextSchema, runDedupedTool} from './tools/toolContext.js';
import {prepareWorkspaceRead} from './tools/workspaceFile.js';
import {toUri} from './lsp/protocol.js';

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
  return message.split('\n').filter(line => line.trim() && !/^\s*at\s/.test(line)).slice(0, 2).join('\n');
}

function lspFailure(error: unknown) {
  return {ok: false, error: cleanLspError(error instanceof Error ? error.message : String(error))};
}

const locationSchema = {
  path: z.string().min(1).describe('Workspace-relative source file path'),
  line: z.number().int().positive().describe('1-based line number'),
  column: z.number().int().positive().describe('1-based column/character number'),
};

const symbolNameSchema = {
  path: z.string().min(1).describe('Workspace-relative source file path'),
  namePath: z.string().min(1).describe('Symbol name or hierarchical name path, such as Class/method'),
};

export const lspTools = buildLspTools();
export type LspTools = typeof lspTools;

/** Build the optional LSP tool set bound to one turn-scoped client pool. */
export function buildLspTools(pool?: LspPool) {
  return {
    lspWorkspaceSymbols: tool({
      description: 'Use a configured language server to search workspace symbols by name. Read-only. Best first LSP tool when you do not know the defining file.',
      inputSchema: z.object({query: z.string().min(1), server: z.string().optional(), maxSymbols: z.number().int().positive().max(100).default(50)}),
      execute: async ({query, server: serverName, maxSymbols}) => {
        const server = await namedOrFirstServer(serverName);
        if (!server) return {ok: false, error: serverName ? `No enabled LSP server named ${serverName}.` : 'No enabled LSP server configured. Use /lsp add <preset>.'};
        try { const symbols = await lspWorkspaceSymbols(server, query, maxSymbols, pool); return {ok: true, server: server.name, query, symbols, truncated: symbols.length >= maxSymbols}; } catch (error) { return lspFailure(error); }
      },
    }),

    lspSymbols: tool({
      description: 'List semantic symbols in a source file, including hierarchical name paths. Use lspFindSymbol for targeted body/signature retrieval.',
      inputSchema: z.object({path: z.string().min(1), maxSymbols: z.number().int().positive().max(200).default(80)}),
      execute: async ({path: filePath, maxSymbols}) => {
        const server = await serverFor(filePath); if (!server) return noServer(filePath);
        try { const symbols = await lspDocumentSymbols(server, filePath, maxSymbols, pool); return {ok: true, server: server.name, path: filePath, symbols, truncated: symbols.length >= maxSymbols}; } catch (error) { return lspFailure(error); }
      },
    }),

    lspFindSymbol: tool({
      description: 'Find a symbol by hierarchical name path. Can scope to a file/directory, retrieve children, exact body text, and hover/signature info.',
      inputSchema: z.object({
        namePath: z.string().min(1),
        path: z.string().optional().describe('Optional workspace-relative file or directory scope'),
        depth: z.number().int().min(0).max(4).default(0),
        includeBody: z.boolean().default(false),
        includeInfo: z.boolean().default(false),
        includeKinds: z.array(z.number().int().positive()).default([]),
        excludeKinds: z.array(z.number().int().positive()).default([]),
        substringMatching: z.boolean().default(false),
        maxResults: z.number().int().positive().max(100).default(20),
      }),
      execute: async (input) => {
        const server = input.path && path.extname(input.path) ? await serverFor(input.path) : await namedOrFirstServer();
        if (!server) return input.path ? noServer(input.path) : {ok: false, error: 'No enabled LSP server configured. Use /lsp add <preset>.'};
        try { const result = await lspFindSymbols(server, input.namePath, input, pool); return {ok: true, server: server.name, ...result, truncated: result.symbols.length >= input.maxResults}; } catch (error) { return lspFailure(error); }
      },
    }),

    lspDefinition: locationTool('Find the definition at a 1-based source position.', 'definition', lspDefinition, pool),
    lspTypeDefinition: locationTool('Find the type definition at a 1-based source position.', 'type definition', lspTypeDefinition, pool),
    lspImplementation: locationTool('Find implementations at a 1-based source position.', 'implementations', lspImplementation, pool, 100),

    lspReferences: tool({
      description: 'Find references and return each location with its enclosing symbol and a compact source snippet.',
      inputSchema: z.object({...locationSchema, maxResults: z.number().int().positive().max(100).default(50)}),
      execute: async ({path: filePath, line, column, maxResults}) => {
        const server = await serverFor(filePath); if (!server) return noServer(filePath);
        try { const references = await lspReferences(server, filePath, line, column, maxResults, pool); return {ok: true, server: server.name, path: filePath, references, locations: references, truncated: references.length >= maxResults}; } catch (error) { return lspFailure(error); }
      },
    }),

    lspRenameSymbol: tool({
      description: 'Rename one symbol across the workspace using the language server. Resolves the symbol by name path immediately before applying the workspace edit.',
      contextSchema: hazeToolContextSchema,
      inputSchema: z.object({...symbolNameSchema, newName: z.string().min(1)}),
      execute: async (input, context) => await runDedupedTool('lspRenameSymbol', input, context, async () => {
        const server = await serverFor(input.path); if (!server) return noServer(input.path);
        try {
          const found = await lspFindSymbols(server, input.namePath, {path: input.path, depth: 0, includeBody: false, includeInfo: false, includeKinds: [], excludeKinds: [], substringMatching: false, maxResults: 2}, pool);
          if (found.symbols.length !== 1) return {ok: false, error: `Expected one symbol named ${input.namePath}, found ${found.symbols.length}.`};
          const position = found.symbols[0]!.selectionRange?.start ?? found.symbols[0]!.range.start;
          return await applyWorkspaceEdit('lspRenameSymbol', await lspRename(server, input.path, position.line, position.character, input.newName, pool), context);
        } catch (error) { return lspFailure(error); }
      }),
    }),

    lspSafeDeleteSymbol: tool({
      description: 'Delete a symbol only when the language server reports no references. Otherwise returns the blocking reference locations without editing.',
      contextSchema: hazeToolContextSchema,
      inputSchema: z.object(symbolNameSchema),
      execute: async (input, context) => await runDedupedTool('lspSafeDeleteSymbol', input, context, async () => {
        const server = await serverFor(input.path); if (!server) return noServer(input.path);
        try {
          const found = await lspFindSymbols(server, input.namePath, {path: input.path, depth: 0, includeBody: false, includeInfo: false, includeKinds: [], excludeKinds: [], substringMatching: false, maxResults: 2}, pool);
          if (found.symbols.length !== 1) return {ok: false, error: `Expected one symbol named ${input.namePath}, found ${found.symbols.length}.`};
          const symbol = found.symbols[0]!;
          const position = symbol.selectionRange?.start ?? symbol.range.start;
          const references = await lspReferenceLocations(server, input.path, position.line, position.character, false, 100, pool);
          if (references.length > 0) return {ok: false, error: `Cannot delete ${symbol.namePath}: ${references.length} reference(s) remain.`, references, recoverable: true, suggestedNextStep: 'Remove or migrate the references, then retry safe delete.'};
          const absolutePath = await prepareWorkspaceRead(input.path, false, context);
          const range = {start: {line: symbol.range.start.line - 1, character: symbol.range.start.character - 1}, end: {line: symbol.range.end.line - 1, character: symbol.range.end.character - 1}};
          return await applyWorkspaceEdit('lspSafeDeleteSymbol', {changes: {[toUri(absolutePath)]: [{range, newText: ''}]}}, context);
        } catch (error) { return lspFailure(error); }
      }),
    }),

    lspDiagnostics: tool({
      description: 'Get diagnostics for one source file. Prefer the relevant build/test command for authoritative validation.',
      inputSchema: z.object({path: z.string().min(1), maxResults: z.number().int().positive().max(100).default(50)}),
      execute: async ({path: filePath, maxResults}) => {
        const server = await serverFor(filePath); if (!server) return noServer(filePath);
        try { const result = await lspDiagnostics(server, filePath, maxResults, pool); return result.ok ? {ok: true, server: server.name, path: filePath, diagnostics: result.diagnostics, truncated: result.diagnostics.length >= maxResults} : result; } catch (error) { return lspFailure(error); }
      },
    }),

    lspDiagnosticsForSymbol: tool({
      description: 'Get diagnostics owned by a symbol and optionally by symbols that reference it. This is a focused intermediate check, not a replacement for tests/typecheck.',
      inputSchema: z.object({...symbolNameSchema, checkReferences: z.boolean().default(false), maxResults: z.number().int().positive().max(100).default(50)}),
      execute: async ({path: filePath, namePath, checkReferences, maxResults}) => {
        const server = await serverFor(filePath); if (!server) return noServer(filePath);
        try { return {ok: true, server: server.name, path: filePath, groups: await lspDiagnosticsForSymbol(server, filePath, namePath, checkReferences, maxResults, pool)}; } catch (error) { return lspFailure(error); }
      },
    }),
  };
}

function locationTool(description: string, label: string, request: typeof lspDefinition, pool: LspPool | undefined, max = 50) {
  return tool({
    description,
    inputSchema: z.object({...locationSchema, maxResults: z.number().int().positive().max(max).default(Math.min(20, max))}),
    execute: async ({path: filePath, line, column, maxResults}) => {
      const server = await serverFor(filePath); if (!server) return noServer(filePath);
      try { const locations = await request(server, filePath, line, column, maxResults, pool); return {ok: true, server: server.name, path: filePath, locations, truncated: locations.length >= maxResults, query: label}; } catch (error) { return lspFailure(error); }
    },
  });
}
