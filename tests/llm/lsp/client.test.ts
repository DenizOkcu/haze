import {afterEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {LspError, StdioLspClient} from '../../../src/llm/lsp/client.js';
import {toUri} from '../../../src/llm/lsp/protocol.js';
import {LSP_FRAME_BYTES, LSP_HEADER_BYTES} from '../../../src/core/limits.js';
import type {HazeLspServer} from '../../../src/config/lspSettings.js';

const ts: HazeLspServer = {name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']};


function frame(message: unknown): Buffer {
  const body = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * Parse the JSON-RPC body out of an outgoing framed `stdin.write` payload.
 *
 * Returns `null` on a missing/incomplete header or a malformed JSON body. The
 * production parser in `src/llm/lsp.ts` throws `LspError` in those cases; the
 * test helper is intentionally permissive so it can stub responses without
 * needing fully-formed frames for every assertion.
 */
function parseOutgoing(data: string): {id?: number; method: string} | null {
  const match = /Content-Length: \d+\r\n\r\n([\s\S]*)/.exec(data);
  if (!match) return null;
  try {
    return JSON.parse(match[1] ?? '') as {id?: number; method: string};
  } catch {
    return null;
  }
}

/**
 * A minimal stand-in for a spawned stdio child process. The child itself is an
 * EventEmitter (for `error`/`exit`), with `stdout`/`stderr` as EventEmitters and a
 * `stdin` that captures writes and auto-responds to `shutdown` so close() is fast.
 */
function fakeChild(): ChildProcessWithoutNullStreams & {stdout: EventEmitter; stderr: EventEmitter; stdin: {write: (data: string) => void}; killedBy?: string} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killedBy: string | undefined;
  const stdin = {
    write: vi.fn((data: string) => {
      const message = parseOutgoing(data);
      if (message?.method === 'shutdown' && typeof message.id === 'number') {
        // Defer the response so it lands after `request()` registers the pending
        // entry (pending.set runs synchronously after send returns).
        queueMicrotask(() => stdout.emit('data', frame({id: message.id, result: null})));
      }
    }),
  };
  const child = new EventEmitter() as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; stdin: {write: (data: string) => void}; kill: (signal?: string) => boolean; killedBy?: string};
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = (signal?: string) => {
    killedBy = signal;
    return true;
  };
  Object.defineProperty(child, 'killedBy', {get: () => killedBy});
  return child as unknown as ChildProcessWithoutNullStreams & {stdout: EventEmitter; stderr: EventEmitter; stdin: {write: (data: string) => void}; killedBy?: string};
}

function sentId(child: ReturnType<typeof fakeChild>, index = 0): number {
  const sent = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls[index][0] as string;
  return Number(/"id":\s*(\d+)/.exec(sent)?.[1]);
}


describe('StdioLspClient', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects start when the server has no command', () => {
    expect(() => StdioLspClient.start({name: 'empty', command: '', extensions: ['.ts']})).toThrow(LspError);
  });

  it('resolves a request when the framed response arrives', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', {query: 'foo'});
    child.stdout.emit('data', frame({id: sentId(child), result: [{name: 'hit'}]}));
    await expect(pending).resolves.toEqual([{name: 'hit'}]);
    await client.close();
  });

  it('rejects when the server returns an error result', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('textDocument/definition', undefined, 1000);
    child.stdout.emit('data', frame({id: sentId(child), error: {message: 'no such symbol'}}));
    await expect(pending).rejects.toThrow('no such symbol');
  });

  it('times out when no response arrives', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 50);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('rejects all pending requests when the child exits', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const assertion = expect(pending).rejects.toThrow('LSP server exited with code 1');
    child.emit('exit', 1);
    await assertion;
  });

  it('rejects all pending requests on child error', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const assertion = expect(pending).rejects.toThrow('spawn failed');
    child.emit('error', new Error('spawn failed'));
    await assertion;
  });

  it('parses messages split across multiple data chunks', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const id = sentId(child);
    const buf = frame({id, result: {ok: true}});
    child.stdout.emit('data', buf.subarray(0, 5));
    child.stdout.emit('data', buf.subarray(5));
    await expect(pending).resolves.toEqual({ok: true});
    await client.close();
  });

  it('ignores responses without a matching pending request', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    child.stdout.emit('data', frame({id: 999, result: null}));
    const pending = client.request('workspace/symbol', undefined, 1000);
    child.stdout.emit('data', frame({id: sentId(child), result: 'done'}));
    await expect(pending).resolves.toBe('done');
    await client.close();
  });

  it('rejects pending requests instead of throwing from malformed response headers', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const assertion = expect(pending).rejects.toThrow('Malformed LSP response');
    child.stdout.emit('data', Buffer.from('Nope: 1\r\n\r\n{}'));
    await assertion;
    expect(child.killedBy).toBe('SIGTERM');
  });

  it('rejects pending requests instead of throwing from malformed JSON bodies', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const assertion = expect(pending).rejects.toThrow();
    child.stdout.emit('data', Buffer.from('Content-Length: 1\r\n\r\n{'));
    await assertion;
    expect(child.killedBy).toBe('SIGTERM');
  });

  it('terminates the client when an unterminated header exceeds the cap', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const assertion = expect(pending).rejects.toThrow(/header exceeds/);
    child.stdout.emit('data', Buffer.alloc(LSP_HEADER_BYTES + 1, 65));
    await assertion;
    expect(child.killedBy).toBe('SIGTERM');
  });

  it('terminates the client before buffering an oversized declared frame', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('workspace/symbol', undefined, 1000);
    const assertion = expect(pending).rejects.toThrow(/frame exceeds/);
    child.stdout.emit('data', Buffer.from(`Content-Length: ${LSP_FRAME_BYTES + 1}\r\n\r\n`));
    await assertion;
    expect(child.killedBy).toBe('SIGTERM');
  });

  it('sends shutdown + exit and kills the child on close', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    await client.close();
    const sent = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
    expect(sent.some(s => s.includes('"shutdown"'))).toBe(true);
    expect(sent.some(s => s.includes('"exit"'))).toBe(true);
    expect(child.killedBy).toBe('SIGTERM');
  });

  it('escalates LSP termination when the process tree does not exit', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    await client.close();
    expect(child.killedBy).toBe('SIGTERM');
    await vi.advanceTimersByTimeAsync(500);
    expect(child.killedBy).toBe('SIGKILL');
  });

  it('stores push diagnostics from publishDiagnostics notifications and drops them on close', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const uri = toUri('/tmp/foo/bar.ts');
    child.stdout.emit('data', frame({method: 'textDocument/publishDiagnostics', params: {uri, diagnostics: [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}, severity: 1, message: 'boom'}]}}));
    expect(client.publishedDiagnostics(uri)).toEqual([{range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}, severity: 1, message: 'boom'}]);
    client.closeDocument('/tmp/foo/bar.ts');
    expect(client.publishedDiagnostics(uri)).toBeUndefined();
    await client.close();
  });

  it('ignores notifications other than publishDiagnostics', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const uri = toUri('/tmp/foo/bar.ts');
    child.stdout.emit('data', frame({method: 'window/logMessage', params: {uri, message: 'noise'}}));
    child.stdout.emit('data', frame({method: 'textDocument/publishDiagnostics', params: {diagnostics: []}}));
    child.stdout.emit('data', frame({method: 'textDocument/publishDiagnostics', params: {uri: 42}}));
    expect(client.publishedDiagnostics(uri)).toBeUndefined();
    await client.close();
  });

  it('still resolves requests interleaved with notification frames', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const pending = client.request('textDocument/documentSymbol', undefined, 1000);
    const uri = toUri('/tmp/foo/bar.ts');
    child.stdout.emit('data', frame({method: 'textDocument/publishDiagnostics', params: {uri, diagnostics: []}}));
    child.stdout.emit('data', frame({id: sentId(child), result: []}));
    await expect(pending).resolves.toEqual([]);
    await client.close();
  });

  it('detects pull-diagnostics support from the initialize result', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    expect(client.diagnosticPullSupported()).toBe(false);
    const initializing = client.initialize();
    child.stdout.emit('data', frame({id: sentId(child), result: {capabilities: {textDocumentDiagnostic: {interFileDependencies: true}}}}));
    await initializing;
    expect(client.diagnosticPullSupported()).toBe(true);
    await client.close();
  });

  it('reports no pull support when capabilities omit textDocumentDiagnostic', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    const initializing = client.initialize();
    child.stdout.emit('data', frame({id: sentId(child), result: {capabilities: {hoverProvider: true}}}));
    await initializing;
    expect(client.diagnosticPullSupported()).toBe(false);
    await client.close();
  });
});
