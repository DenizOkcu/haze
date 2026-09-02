import fs from 'node:fs/promises';
import type {HazeLspServer} from '../../config/lspSettings.js';
import {workspaceRelativePath} from '../../utils/path.js';
import {prepareWorkspaceRead} from '../tools/workspaceFile.js';
import {diagnosticsFrom, isObject, locationToWorkspaceResult, toUri, type LspDiagnostic, type LspRange} from './protocol.js';
import {LspError, StdioLspClient} from './client.js';
import type {LspPool} from './pool.js';
import {flattenSemanticSymbols, matchesNamePath, readRange, readSnippet, semanticSymbols, smallestContainingSymbol, type SemanticSymbol} from './symbols.js';

/** Workspace-safe LSP request facades used by the AI-SDK tool layer. */

async function withLspClient<T>(server: HazeLspServer, filePath: string, pool: LspPool | undefined, fn: (client: StdioLspClient, absolutePath: string) => Promise<T>): Promise<T> {
  const absolutePath = await prepareWorkspaceRead(filePath, false);
  if (pool) {
    let client = await pool.getClient(server, absolutePath);
    await pool.ensureOpen(server, client, absolutePath);
    try {
      return await fn(client, absolutePath);
    } catch (error) {
      if (!client.terminated && !/\b(exited|terminated|broken pipe|EPIPE)\b/i.test(error instanceof Error ? error.message : String(error))) throw error;
      client = await pool.restart(server);
      await pool.ensureOpen(server, client, absolutePath);
      return await fn(client, absolutePath);
    }
  }
  const client = StdioLspClient.start(server);
  try {
    await client.initialize();
    await client.openDocument(absolutePath);
    return await fn(client, absolutePath);
  } finally {
    await client.close();
  }
}

async function prepareCrossFile(server: HazeLspServer, pool?: LspPool) {
  return pool ? await pool.prepareCrossFileQuery(server) : {changedFiles: 0, indexingComplete: true};
}

async function rawDocumentSymbols(client: StdioLspClient, absolutePath: string) {
  const result = await client.request('textDocument/documentSymbol', {textDocument: {uri: toUri(absolutePath)}});
  return Array.isArray(result) ? result : [];
}

export async function lspDocumentSymbols(server: HazeLspServer, filePath: string, limit: number, pool?: LspPool) {
  return await withLspClient(server, filePath, pool, async (client, absolutePath) => {
    return flattenSemanticSymbols(semanticSymbols(await rawDocumentSymbols(client, absolutePath))).slice(0, limit)
      .map(symbol => ({...symbol, path: workspaceRelativePath(absolutePath)}));
  });
}

export interface FindSymbolOptions {
  path?: string;
  depth: number;
  includeBody: boolean;
  includeInfo: boolean;
  includeKinds: number[];
  excludeKinds: number[];
  substringMatching: boolean;
  maxResults: number;
}

type FoundSymbol = SemanticSymbol & {path: string; body?: string; info?: unknown};

function limitedChildren(symbol: SemanticSymbol, depth: number): SemanticSymbol {
  if (depth <= 0 || !symbol.children) return {...symbol, children: undefined};
  return {...symbol, children: symbol.children.map(child => limitedChildren(child, depth - 1))};
}

function kindAllowed(symbol: SemanticSymbol, options: FindSymbolOptions) {
  if (options.includeKinds.length > 0 && (symbol.kind == null || !options.includeKinds.includes(symbol.kind))) return false;
  return symbol.kind == null || !options.excludeKinds.includes(symbol.kind);
}

export async function lspFindSymbols(server: HazeLspServer, namePath: string, options: FindSymbolOptions, pool?: LspPool): Promise<{symbols: FoundSymbol[]; indexingComplete: boolean}> {
  const scopedPath = options.path?.trim();
  if (!scopedPath) {
    const indexing = await prepareCrossFile(server, pool);
    const symbols = (await lspWorkspaceSymbols(server, namePath.split('/').at(-1) ?? namePath, options.maxResults * 2, pool))
      .filter(symbol => options.substringMatching ? symbol.name.includes(namePath.split('/').at(-1) ?? namePath) : symbol.name === (namePath.split('/').at(-1) ?? namePath))
      .slice(0, options.maxResults)
      .map(symbol => ({...symbol, namePath: symbol.name, range: symbol.range!}));
    return {symbols, indexingComplete: indexing.indexingComplete};
  }

  const absolute = await prepareWorkspaceRead(scopedPath, false);
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) {
    const indexing = await prepareCrossFile(server, pool);
    const prefix = `${workspaceRelativePath(absolute).replace(/\\/g, '/')}/`;
    const symbols = (await lspWorkspaceSymbols(server, namePath.split('/').at(-1) ?? namePath, options.maxResults * 4, pool))
      .filter(symbol => symbol.path.replace(/\\/g, '/').startsWith(prefix))
      .slice(0, options.maxResults)
      .map(symbol => ({...symbol, namePath: symbol.name, range: symbol.range!}));
    return {symbols, indexingComplete: indexing.indexingComplete};
  }

  return await withLspClient(server, scopedPath, pool, async (client, absolutePath) => {
    const all = semanticSymbols(await rawDocumentSymbols(client, absolutePath));
    const matches = flattenSemanticSymbols(all)
      .filter(symbol => matchesNamePath(symbol, namePath, options.substringMatching) && kindAllowed(symbol, options))
      .slice(0, options.maxResults);
    const found: FoundSymbol[] = [];
    for (const match of matches) {
      const symbol: FoundSymbol = {...limitedChildren(match, options.depth), path: workspaceRelativePath(absolutePath)};
      if (options.includeBody) symbol.body = await readRange(absolutePath, match.range);
      if (options.includeInfo) {
        const position = match.selectionRange?.start ?? match.range.start;
        symbol.info = await client.request('textDocument/hover', {textDocument: {uri: toUri(absolutePath)}, position: {line: position.line - 1, character: position.character - 1}}).catch(() => undefined);
      }
      found.push(symbol);
    }
    return {symbols: found, indexingComplete: true};
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
  await prepareCrossFile(server, pool);
  return await withLspClient(server, filePath, pool, (client, absolutePath) => requestLocations(client, absolutePath, 'textDocument/implementation', line, character, limit));
}

async function rawReferences(server: HazeLspServer, filePath: string, line: number, character: number, includeDeclaration: boolean, limit: number, pool?: LspPool) {
  await prepareCrossFile(server, pool);
  return await withLspClient(server, filePath, pool, async (client, absolutePath) => {
    const result = await client.request('textDocument/references', {textDocument: {uri: toUri(absolutePath)}, position: {line: line - 1, character: character - 1}, context: {includeDeclaration}});
    const values = Array.isArray(result) ? result : [];
    return (await Promise.all(values.map(locationToWorkspaceResult))).filter(result => result != null).slice(0, limit);
  });
}

export async function lspReferenceLocations(server: HazeLspServer, filePath: string, line: number, character: number, includeDeclaration: boolean, limit: number, pool?: LspPool) {
  return await rawReferences(server, filePath, line, character, includeDeclaration, limit, pool);
}

export async function lspRename(server: HazeLspServer, filePath: string, line: number, character: number, newName: string, pool?: LspPool) {
  await prepareCrossFile(server, pool);
  return await withLspClient(server, filePath, pool, async (client, absolutePath) => await client.request('textDocument/rename', {
    textDocument: {uri: toUri(absolutePath)},
    position: {line: line - 1, character: character - 1},
    newName,
  }, 15_000));
}

export async function lspReferences(server: HazeLspServer, filePath: string, line: number, character: number, limit: number, pool?: LspPool) {
  const locations = await rawReferences(server, filePath, line, character, true, limit, pool);
  return await Promise.all(locations.map(async location => {
    if (location.external) return location;
    try {
      const absolutePath = await prepareWorkspaceRead(location.path, false);
      const owner = await withLspClient(server, location.path, pool, async (client, openedPath) => smallestContainingSymbol(semanticSymbols(await rawDocumentSymbols(client, openedPath)), location.range.start.line, location.range.start.character));
      return {...location, ...(owner ? {owner: {namePath: owner.namePath, kind: owner.kind, range: owner.range}} : {}), snippet: await readSnippet(absolutePath, location.range.start.line)};
    } catch {
      return location;
    }
  }));
}

async function pullDiagnostics(client: StdioLspClient, absolutePath: string, limit: number) {
  const result = await client.request('textDocument/documentDiagnostic', {textDocument: {uri: toUri(absolutePath)}}, 15000);
  const items = isObject(result) && Array.isArray(result.items) ? result.items : [];
  return diagnosticsFrom(items, limit);
}

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

function rangesOverlap(a: LspRange, b: LspRange) {
  return a.start.line <= b.end.line && b.start.line <= a.end.line;
}

export async function lspDiagnosticsForSymbol(server: HazeLspServer, filePath: string, namePath: string, checkReferences: boolean, limit: number, pool?: LspPool) {
  const found = await lspFindSymbols(server, namePath, {path: filePath, depth: 0, includeBody: false, includeInfo: false, includeKinds: [], excludeKinds: [], substringMatching: false, maxResults: 2}, pool);
  if (found.symbols.length !== 1) throw new LspError(`Expected one symbol named ${namePath} in ${filePath}, found ${found.symbols.length}.`);
  const target = found.symbols[0]!;
  const diagnosticsBySymbol: Array<{path: string; namePath: string; diagnostics: LspDiagnostic[]}> = [];
  const own = await lspDiagnostics(server, filePath, limit, pool);
  if (own.ok) diagnosticsBySymbol.push({path: filePath, namePath: target.namePath, diagnostics: own.diagnostics.filter(diagnostic => rangesOverlap(diagnostic.range!, target.range))});
  if (checkReferences) {
    const position = target.selectionRange?.start ?? target.range.start;
    const references = await lspReferences(server, filePath, position.line, position.character, limit, pool);
    for (const reference of references) {
      if (reference.external || !('owner' in reference) || !reference.owner) continue;
      const owner = reference.owner;
      const result = await lspDiagnostics(server, reference.path, limit, pool);
      if (result.ok) diagnosticsBySymbol.push({path: reference.path, namePath: owner.namePath, diagnostics: result.diagnostics.filter(diagnostic => rangesOverlap(diagnostic.range, owner.range))});
    }
  }
  return diagnosticsBySymbol.filter(group => group.diagnostics.length > 0).slice(0, limit);
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
  if (pool) {
    await pool.prepareCrossFileQuery(server);
    let client = await pool.getClient(server);
    try { return await run(client); } catch (error) {
      if (!client.terminated && !/\b(exited|terminated|broken pipe|EPIPE)\b/i.test(error instanceof Error ? error.message : String(error))) throw error;
      client = await pool.restart(server);
      return await run(client);
    }
  }
  const client = StdioLspClient.start(server);
  try {
    await client.initialize();
    return await run(client);
  } finally {
    await client.close();
  }
}
