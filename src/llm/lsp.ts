import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {HazeLspServer} from '../config/lspSettings.js';
import {resolveWorkspacePath, workspaceRelativePath, workspaceRoot} from '../utils/path.js';

type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
type JsonObject = {[key: string]: Json | undefined};
type Pending = {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>};

export class LspError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspError';
  }
}

export function languageId(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.js') return 'javascript';
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.rs') return 'rust';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  return ext.replace(/^\./, '') || 'plaintext';
}

export function toUri(absolutePath: string) {
  return pathToFileURL(absolutePath).toString();
}

export function fromUri(uri: string) {
  if (!uri.startsWith('file://')) return uri;
  return workspaceRelativePath(new URL(uri).pathname);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

export function asRange(value: unknown) {
  if (!isObject(value) || !isObject(value.start) || !isObject(value.end)) return undefined;
  const start = value.start as Record<string, unknown>;
  const end = value.end as Record<string, unknown>;
  return {
    start: {line: typeof start.line === 'number' ? start.line + 1 : 1, character: typeof start.character === 'number' ? start.character + 1 : 1},
    end: {line: typeof end.line === 'number' ? end.line + 1 : 1, character: typeof end.character === 'number' ? end.character + 1 : 1},
  };
}

export function locationToResult(value: unknown) {
  if (!isObject(value)) return undefined;
  const uri = typeof value.uri === 'string' ? value.uri : (typeof value.targetUri === 'string' ? value.targetUri : undefined);
  const range = asRange(value.range ?? value.targetSelectionRange ?? value.targetRange);
  if (!uri || !range) return undefined;
  return {path: fromUri(uri), range};
}

export function flattenSymbols(symbols: unknown[], filePath: string, limit: number) {
  const out: Array<{name: string; kind?: number; path: string; range?: ReturnType<typeof asRange>; selectionRange?: ReturnType<typeof asRange>}> = [];
  const visit = (items: unknown[]) => {
    for (const item of items) {
      if (out.length >= limit || !isObject(item)) return;
      if (typeof item.name === 'string') {
        out.push({
          name: item.name,
          kind: typeof item.kind === 'number' ? item.kind : undefined,
          path: filePath,
          range: asRange(item.range),
          selectionRange: asRange(item.selectionRange),
        });
      }
      if (Array.isArray(item.children)) visit(item.children);
    }
  };
  visit(symbols);
  return out;
}

export function pickLspServer(servers: HazeLspServer[], filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return servers.find(server => server.enabled !== false && (server.extensions ?? []).map(e => e.toLowerCase()).includes(ext));
}

export class StdioLspClient {
  private id = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();

  constructor(private server: HazeLspServer, private child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', chunk => {
      try {
        this.onData(chunk);
      } catch (error) {
        const lspError = error instanceof Error ? error : new LspError(String(error));
        this.rejectAll(lspError);
        this.child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', error => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', code => this.rejectAll(new LspError(`LSP server exited${code == null ? '' : ` with code ${code}`}`)));
  }

  static start(server: HazeLspServer) {
    if (!server.command) throw new LspError(`LSP server ${server.name} has no command.`);
    const child = spawn(server.command, server.args ?? [], {cwd: workspaceRoot(), stdio: ['pipe', 'pipe', 'pipe']});
    return new StdioLspClient(server, child);
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new LspError('Malformed LSP response: missing Content-Length.');
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const raw = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + length);
      const message = JSON.parse(raw) as {id?: number; result?: unknown; error?: {message?: string}};
      if (typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new LspError(message.error.message ?? 'LSP request failed.'));
      else pending.resolve(message.result);
    }
  }

  private send(message: JsonObject) {
    const body = JSON.stringify({...message, jsonrpc: '2.0'});
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  request(method: string, params?: Json, timeoutMs = 8000) {
    const id = ++this.id;
    this.send({id, method, params});
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
    });
  }

  notify(method: string, params?: Json) {
    this.send({method, params});
  }

  async initialize() {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: toUri(workspaceRoot()),
      capabilities: {
        textDocument: {
          documentSymbol: {hierarchicalDocumentSymbolSupport: true},
          definition: {linkSupport: true},
          references: {},
        },
        workspace: {symbol: {}},
      },
    });
    this.notify('initialized', {});
  }

  async openDocument(absolutePath: string) {
    const text = await fs.readFile(absolutePath, 'utf8');
    this.notify('textDocument/didOpen', {
      textDocument: {uri: toUri(absolutePath), languageId: languageId(absolutePath), version: 1, text},
    });
  }

  async close() {
    try {
      await this.request('shutdown', null, 2000).catch(() => undefined);
      this.notify('exit');
    } finally {
      this.child.kill('SIGTERM');
    }
  }
}

async function withLsp<T>(server: HazeLspServer, filePath: string, fn: (client: StdioLspClient, absolutePath: string) => Promise<T>) {
  const absolutePath = resolveWorkspacePath(filePath);
  const client = StdioLspClient.start(server);
  try {
    await client.initialize();
    await client.openDocument(absolutePath);
    return await fn(client, absolutePath);
  } finally {
    await client.close();
  }
}

export async function lspDocumentSymbols(server: HazeLspServer, filePath: string, limit: number) {
  return await withLsp(server, filePath, async (client, absolutePath) => {
    const result = await client.request('textDocument/documentSymbol', {textDocument: {uri: toUri(absolutePath)}});
    const symbols = Array.isArray(result) ? result : [];
    return flattenSymbols(symbols, workspaceRelativePath(absolutePath), limit);
  });
}

export async function lspDefinition(server: HazeLspServer, filePath: string, line: number, character: number, limit: number) {
  return await withLsp(server, filePath, async (client, absolutePath) => {
    const result = await client.request('textDocument/definition', {textDocument: {uri: toUri(absolutePath)}, position: {line: line - 1, character: character - 1}});
    const values = Array.isArray(result) ? result : result ? [result] : [];
    return values.map(locationToResult).filter(result => result != null).slice(0, limit);
  });
}

export async function lspReferences(server: HazeLspServer, filePath: string, line: number, character: number, limit: number) {
  return await withLsp(server, filePath, async (client, absolutePath) => {
    const result = await client.request('textDocument/references', {textDocument: {uri: toUri(absolutePath)}, position: {line: line - 1, character: character - 1}, context: {includeDeclaration: true}});
    const values = Array.isArray(result) ? result : [];
    return values.map(locationToResult).filter(result => result != null).slice(0, limit);
  });
}

export async function lspWorkspaceSymbols(server: HazeLspServer, query: string, limit: number) {
  const client = StdioLspClient.start(server);
  try {
    await client.initialize();
    const result = await client.request('workspace/symbol', {query});
    const values = Array.isArray(result) ? result : [];
    return values.flatMap(value => {
      if (!isObject(value) || typeof value.name !== 'string') return [];
      const location = locationToResult(value.location);
      return [{name: value.name, kind: typeof value.kind === 'number' ? value.kind : undefined, ...location}];
    }).slice(0, limit);
  } finally {
    await client.close();
  }
}
