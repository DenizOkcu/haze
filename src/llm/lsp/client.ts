import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {HazeLspServer} from '../../config/lspSettings.js';
import {workspaceRoot} from '../../utils/path.js';
import {LSP_BUFFER_BYTES, LSP_DOCUMENT_BYTES, LSP_FRAME_BYTES, LSP_HEADER_BYTES} from '../../core/limits.js';
import {readUtf8Prefix} from '../../core/io/boundedRead.js';
import {signalProcessTree} from '../../core/process/runBoundedProcess.js';
import {isObject, languageId, toUri} from './protocol.js';

/**
 * Stdio JSON-RPC LSP client: framing, request/response correlation, push
 * notifications, and bounded teardown. One client wraps one spawned server
 * process; reuse across requests is owned by `pool.ts`.
 */

type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
type JsonObject = {[key: string]: Json | undefined};
type Pending = {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>};

export class LspError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspError';
  }
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
