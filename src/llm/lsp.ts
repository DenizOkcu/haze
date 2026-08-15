import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {HazeLspServer} from '../config/lspSettings.js';
import {assertRealPathInsideWorkspace, workspaceRelativePath, workspaceRoot} from '../utils/path.js';
import {prepareWorkspaceRead} from './tools/workspaceFile.js';
import {LSP_BUFFER_BYTES, LSP_DOCUMENT_BYTES, LSP_FRAME_BYTES, LSP_HEADER_BYTES} from '../core/limits/byteBudgets.js';
import {readUtf8Prefix} from '../core/io/boundedRead.js';
import {signalProcessTree} from '../core/process/runBoundedProcess.js';

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

export function fromUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try { return workspaceRelativePath(fileURLToPath(uri)); } catch { return uri; }
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
  const resultPath = fromUri(uri);
  const external = !uri.startsWith('file://') || resultPath.startsWith('..') || path.isAbsolute(resultPath);
  return {path: resultPath, range, ...(external ? {external: true} : {})};
}

export async function locationToWorkspaceResult(value: unknown) {
  const result = locationToResult(value);
  if (!result || result.external) return result;
  if (!isObject(value)) return undefined;
  const uri = typeof value.uri === 'string' ? value.uri : (typeof value.targetUri === 'string' ? value.targetUri : undefined);
  if (!uri?.startsWith('file://')) return result;
  try {
    const absolutePath = fileURLToPath(uri);
    await assertRealPathInsideWorkspace(absolutePath, uri);
    return result;
  } catch {
    return {...result, path: uri, external: true as const};
  }
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
  private terminating = false;
  private initializeResult: unknown;
  private readonly published = new Map<string, {diagnostics: unknown[]; version?: number}>();

  constructor(private server: HazeLspServer, private child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', chunk => {
      try {
        this.onData(chunk);
      } catch (error) {
        const lspError = error instanceof Error ? error : new LspError(String(error));
        this.rejectAll(lspError);
        this.terminate();
      }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', error => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', code => this.rejectAll(new LspError(`LSP server exited${code == null ? '' : ` with code ${code}`}`)));
  }

  static start(server: HazeLspServer) {
    if (!server.command) throw new LspError(`LSP server ${server.name} has no command.`);
    const child = spawn(server.command, server.args ?? [], {cwd: workspaceRoot(), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    return new StdioLspClient(server, child);
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminate() {
    if (this.terminating) return;
    this.terminating = true;
    signalProcessTree(this.child, 'SIGTERM');
    const forceTimer = setTimeout(() => signalProcessTree(this.child, 'SIGKILL'), 500);
    forceTimer.unref?.();
    this.child.stdin.destroy?.();
    this.child.stdout.destroy?.();
    this.child.stderr.destroy?.();
  }

  /** Whether this client has begun (or completed) teardown and must not be reused. */
  get terminated() {
    return this.terminating;
  }

  private onData(chunk: Buffer) {
    if (this.buffer.length + chunk.length > LSP_BUFFER_BYTES) throw new LspError(`LSP receive buffer exceeds ${LSP_BUFFER_BYTES} bytes.`);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.length > LSP_HEADER_BYTES) throw new LspError(`LSP header exceeds ${LSP_HEADER_BYTES} bytes.`);
        return;
      }
      if (headerEnd > LSP_HEADER_BYTES) throw new LspError(`LSP header exceeds ${LSP_HEADER_BYTES} bytes.`);
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new LspError('Malformed LSP response: missing Content-Length.');
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > LSP_FRAME_BYTES) throw new LspError(`LSP frame exceeds ${LSP_FRAME_BYTES} bytes.`);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const raw = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + length);
      const message = JSON.parse(raw) as {id?: number; method?: string; params?: unknown; result?: unknown; error?: {message?: string}};
      if (typeof message.id !== 'number') {
        // Server-initiated notification; only diagnostics are consumed, others are dropped.
        if (typeof message.method === 'string') this.handleNotification(message.method, message.params);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new LspError(message.error.message ?? 'LSP request failed.'));
      else pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: unknown) {
    if (method !== 'textDocument/publishDiagnostics') return;
    if (!isObject(params) || typeof params.uri !== 'string') return;
    const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
    this.published.set(params.uri, {diagnostics, version: typeof params.version === 'number' ? params.version : undefined});
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
    this.initializeResult = await this.request('initialize', {
      processId: process.pid,
      rootUri: toUri(workspaceRoot()),
      capabilities: {
        textDocument: {
          documentSymbol: {hierarchicalDocumentSymbolSupport: true},
          definition: {linkSupport: true},
          typeDefinition: {linkSupport: true},
          implementation: {linkSupport: true},
          references: {},
          diagnostic: {},
        },
        workspace: {symbol: {}},
      },
    });
    this.notify('initialized', {});
  }

  /** Server capabilities from the initialize handshake; undefined until it completes. */
  get capabilities() {
    return this.initializeResult;
  }

  /** Whether the server advertised pull diagnostics (`textDocument/documentDiagnostic`). */
  diagnosticPullSupported() {
    const result = this.initializeResult;
    if (!isObject(result) || !isObject(result.capabilities)) return false;
    return isObject(result.capabilities.textDocumentDiagnostic);
  }

  /** Latest push-published diagnostics for a document URI, if any arrived. */
  publishedDiagnostics(uri: string) {
    return this.published.get(uri)?.diagnostics;
  }

  async openDocument(absolutePath: string) {
    const document = await readUtf8Prefix(absolutePath, LSP_DOCUMENT_BYTES);
    if (document.truncated) throw new LspError(`LSP document exceeds ${LSP_DOCUMENT_BYTES} byte limit.`);
    const text = document.content;
    this.notify('textDocument/didOpen', {
      textDocument: {uri: toUri(absolutePath), languageId: languageId(absolutePath), version: 1, text},
    });
  }

  closeDocument(absolutePath: string) {
    const uri = toUri(absolutePath);
    this.notify('textDocument/didClose', {textDocument: {uri}});
    // Servers may publish an empty set on close; drop the stale snapshot either way.
    this.published.delete(uri);
  }

  async close() {
    if (this.terminating) return;
    try {
      await this.request('shutdown', null, 2000).catch(() => undefined);
      this.notify('exit');
    } finally {
      this.terminate();
    }
  }
}

/**
 * Turn-scoped pool of reused LSP clients (RH-009). Autonomous code navigation
 * issues many symbols/definition/references calls per turn; reusing one
 * initialized server and its opened documents avoids repeating expensive
 * startup and indexing on every call. Clients are keyed by server name; a
 * crashed/terminated client is evicted so the next call restarts it.
 */
export class LspPool {
  private readonly clients = new Map<string, StdioLspClient>();
  private readonly openedDocuments = new Map<string, Set<string>>();
  private readonly openSnapshots = new Map<string, string>();
  private closed = false;

  /** Get (or lazily start + initialize) the reusable client for a server. */
  async getClient(server: HazeLspServer, filePath?: string): Promise<StdioLspClient> {
    const existing = this.clients.get(server.name);
    if (existing && !existing.terminated) {
      // Read-only navigation must not serve stale positions: when a document was
      // modified on disk since it was opened, close/reopen it so the server sees
      // the current text before answering position-based requests.
      if (filePath) {
        const snapshot = this.openSnapshots.get(filePath);
        if (snapshot !== undefined && snapshot !== await fileFingerprint(filePath)) {
          const absolutePath = path.resolve(workspaceRoot(), filePath);
          const uri = toUri(absolutePath);
          existing.closeDocument(absolutePath);
          this.openedDocuments.get(server.name)?.delete(uri);
          await existing.openDocument(absolutePath);
          this.openedDocuments.get(server.name)?.add(uri);
          this.openSnapshots.set(filePath, await fileFingerprint(filePath));
        }
      }
      return existing;
    }
    const client = StdioLspClient.start(server);
    await client.initialize();
    if (this.closed) { await client.close(); throw new LspError('LSP pool closed during initialization.'); }
    this.clients.set(server.name, client);
    this.openedDocuments.set(server.name, new Set());
    return client;
  }

  /** Open a document once per client; subsequent calls for the same URI are no-ops. */
  async ensureOpen(server: HazeLspServer, client: StdioLspClient, absolutePath: string): Promise<void> {
    const uri = toUri(absolutePath);
    const opened = this.openedDocuments.get(server.name);
    if (opened && opened.has(uri)) return;
    await client.openDocument(absolutePath);
    opened?.add(uri);
    const relative = workspaceRelativePath(absolutePath);
    this.openSnapshots.set(relative, await fileFingerprint(absolutePath));
  }

  /** Bounded teardown of every pooled client. Safe to call once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.openedDocuments.clear();
    this.openSnapshots.clear();
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  }
}

/** Cheap file fingerprint (mtime + size) used to detect on-disk modification. */
async function fileFingerprint(absolutePath: string) {
  try {
    const stats = await fs.stat(absolutePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return '';
  }
}

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

/** Structured, workspace-safe summary of one LSP diagnostic. */
export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'information' | 'hint';
  range: ReturnType<typeof asRange>;
  message: string;
  code?: string;
  source?: string;
}

const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;

export function toDiagnostic(value: unknown): LspDiagnostic | undefined {
  if (!isObject(value)) return undefined;
  const range = asRange(value.range);
  if (!range) return undefined;
  const severity = typeof value.severity === 'number' && value.severity >= 1 && value.severity <= 4
    ? DIAGNOSTIC_SEVERITIES[value.severity - 1]
    : 'information';
  const code = typeof value.code === 'number' || typeof value.code === 'string' ? String(value.code) : undefined;
  const source = typeof value.source === 'string' ? value.source : undefined;
  return {severity, range, message: typeof value.message === 'string' ? value.message : '', ...(code ? {code} : {}), ...(source ? {source} : {})};
}

function diagnosticsFrom(values: unknown[], limit: number) {
  const out: LspDiagnostic[] = [];
  for (const value of values) {
    if (out.length >= limit) break;
    const diagnostic = toDiagnostic(value);
    if (diagnostic) out.push(diagnostic);
  }
  return out;
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
