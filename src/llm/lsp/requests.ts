import type {HazeLspServer} from '../../config/lspSettings.js';
import {workspaceRelativePath} from '../../utils/path.js';
import {prepareWorkspaceRead} from '../tools/workspaceFile.js';
import {diagnosticsFrom, flattenSymbols, isObject, locationToWorkspaceResult, toUri, type LspDiagnostic} from './protocol.js';
import {LspError, StdioLspClient} from './client.js';
import type {LspPool} from './pool.js';

/**
 * Workspace-safe LSP request facades: document symbols, definitions,
 * implementations, references, diagnostics, and workspace symbols. Each facade
 * resolves the path through workspace-read confinement, then runs on a pooled
 * client (or a single-call fallback lifecycle). This module is the seam the
 * AI-SDK tools (`lspTools.ts`) and their tests program against.
 */

async function withLspClient<T>(server: HazeLspServer, filePath: string, pool: LspPool | undefined, fn: (client: StdioLspClient, absolutePath: string) => Promise<T>): Promise<T> {
  const absolutePath = await prepareWorkspaceRead(filePath, false);
  if (pool) {
    const client = await pool.getClient(server, absolutePath);
    await pool.ensureOpen(server, client, absolutePath);
    return fn(client, absolutePath);
  }
  // Single-call fallback (no pool): full server lifecycle per invocation.
  const client = StdioLspClient.start(server);
  try {
    await client.initialize();
    await client.openDocument(absolutePath);
    return await fn(client, absolutePath);
  } finally {
    await client.close();
  }
}

export async function lspDocumentSymbols(server: HazeLspServer, filePath: string, limit: number, pool?: LspPool) {
  return await withLspClient(server, filePath, pool, async (client, absolutePath) => {
    const result = await client.request('textDocument/documentSymbol', {textDocument: {uri: toUri(absolutePath)}});
    const symbols = Array.isArray(result) ? result : [];
    return flattenSymbols(symbols, workspaceRelativePath(absolutePath), limit);
  });
}

async function requestLocations(client: StdioLspClient, absolutePath: string, method: 'textDocument/definition' | 'textDocument/typeDefinition' | 'textDocument/implementation', line: number, character: number, limit: number) {
  const result = await client.request(method, {textDocument: {uri: toUri(absolutePath)}, position: {line: line - 1, character: character - 1}});
  const values = Array.isArray(result) ? result : result ? [result] : [];
  return (await Promise.all(values.map(locationToWorkspaceResult))).filter(result => result != null).slice(0, limit);
}

export async function lspDefinition(server: HazeLspServer, filePath: string, line: number, character: number, limit: number, pool?: LspPool) {
  return await withLspClient(server, filePath, pool, (client, absolutePath) => requestLocations(client, absolutePath, 'textDocument/definition', line, character, limit));
}

export async function lspTypeDefinition(server: HazeLspServer, filePath: string, line: number, character: number, limit: number, pool?: LspPool) {
  return await withLspClient(server, filePath, pool, (client, absolutePath) => requestLocations(client, absolutePath, 'textDocument/typeDefinition', line, character, limit));
}

export async function lspImplementation(server: HazeLspServer, filePath: string, line: number, character: number, limit: number, pool?: LspPool) {
  return await withLspClient(server, filePath, pool, (client, absolutePath) => requestLocations(client, absolutePath, 'textDocument/implementation', line, character, limit));
}

export async function lspReferences(server: HazeLspServer, filePath: string, line: number, character: number, limit: number, pool?: LspPool) {
  return await withLspClient(server, filePath, pool, async (client, absolutePath) => {
    const result = await client.request('textDocument/references', {textDocument: {uri: toUri(absolutePath)}, position: {line: line - 1, character: character - 1}, context: {includeDeclaration: true}});
    const values = Array.isArray(result) ? result : [];
    return (await Promise.all(values.map(locationToWorkspaceResult))).filter(result => result != null).slice(0, limit);
  });
}

async function pullDiagnostics(client: StdioLspClient, absolutePath: string, limit: number) {
  const result = await client.request('textDocument/documentDiagnostic', {textDocument: {uri: toUri(absolutePath)}}, 15000);
  const items = isObject(result) && Array.isArray(result.items) ? result.items : [];
  return diagnosticsFrom(items, limit);
}

/** Wait briefly for `textDocument/publishDiagnostics` push diagnostics after didOpen. */
async function awaitPushDiagnostics(client: StdioLspClient, absolutePath: string, limit: number, waitMs: number) {
  const uri = toUri(absolutePath);
  const deadline = Date.now() + waitMs;
  while (true) {
    const published = client.publishedDiagnostics(uri);
    if (published) return diagnosticsFrom(published, limit);
    if (Date.now() >= deadline) return [];
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}

/**
 * Diagnostics for one document: pull (`textDocument/documentDiagnostic`) when the
 * server advertises it, otherwise the latest push-published set after didOpen.
 * A timed-out pull falls back to push instead of failing the whole request.
 */
export async function lspDiagnostics(server: HazeLspServer, filePath: string, limit: number, pool?: LspPool): Promise<{ok: true; diagnostics: LspDiagnostic[]} | {ok: false; error: string}> {
  return await withLspClient(server, filePath, pool, async (client, absolutePath) => {
    if (client.diagnosticPullSupported()) {
      try {
        return {ok: true as const, diagnostics: await pullDiagnostics(client, absolutePath, limit)};
      } catch (error) {
        if (!(error instanceof LspError) || !/timed out/.test(error.message)) throw error;
      }
    }
    return {ok: true as const, diagnostics: await awaitPushDiagnostics(client, absolutePath, limit, 500)};
  });
}

export async function lspWorkspaceSymbols(server: HazeLspServer, query: string, limit: number, pool?: LspPool) {
  const run = async (client: StdioLspClient) => {
    const result = await client.request('workspace/symbol', {query});
    const values = Array.isArray(result) ? result : [];
    const locations = await Promise.all(values.map(async value => {
      if (!isObject(value) || typeof value.name !== 'string') return [];
      const location = await locationToWorkspaceResult(value.location);
      if (!location) return [];
      return [{name: value.name, kind: typeof value.kind === 'number' ? value.kind : undefined, ...location}];
    }));
    return locations.flat().slice(0, limit);
  };
  if (pool) return run(await pool.getClient(server));
  const client = StdioLspClient.start(server);
  try {
    await client.initialize();
    return await run(client);
  } finally {
    await client.close();
  }
}
