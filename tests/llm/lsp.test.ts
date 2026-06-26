import {afterEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {
  LspError,
  StdioLspClient,
  asRange,
  flattenSymbols,
  fromUri,
  languageId,
  locationToResult,
  pickLspServer,
  toUri,
} from '../../src/llm/lsp.js';
import type {HazeLspServer} from '../../src/config/lspSettings.js';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';

const ts: HazeLspServer = {name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']};
const py: HazeLspServer = {name: 'python', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py']};

describe('pickLspServer', () => {
  it('matches a server by file extension', () => {
    expect(pickLspServer([ts, py], 'src/app.ts')?.name).toBe('typescript');
    expect(pickLspServer([ts, py], 'src/app.tsx')?.name).toBe('typescript');
    expect(pickLspServer([ts, py], 'scripts/main.py')?.name).toBe('python');
  });

  it('matches case-insensitively', () => {
    expect(pickLspServer([ts], 'SRC/APP.TSX')?.name).toBe('typescript');
  });

  it('skips disabled servers and falls through to the next match', () => {
    expect(pickLspServer([{...ts, enabled: false}, py], 'app.ts')).toBeUndefined();
    expect(pickLspServer([{...ts, enabled: false}, py], 'app.py')?.name).toBe('python');
  });

  it('returns undefined when no server covers the extension', () => {
    expect(pickLspServer([ts, py], 'README.md')).toBeUndefined();
    expect(pickLspServer([], 'app.ts')).toBeUndefined();
  });

  it('handles a server without an extensions list', () => {
    const noext: HazeLspServer = {name: 'none', command: 'x'};
    expect(pickLspServer([noext], 'app.ts')).toBeUndefined();
  });

  it('prefers the first matching server when several could match', () => {
    const ts2: HazeLspServer = {...ts, name: 'typescript-2'};
    expect(pickLspServer([ts, ts2], 'app.ts')?.name).toBe('typescript');
  });
});

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

describe('lsp pure helpers', () => {
  it('maps file extensions to language ids', () => {
    expect(languageId('a.ts')).toBe('typescript');
    expect(languageId('a.tsx')).toBe('typescriptreact');
    expect(languageId('a.js')).toBe('javascript');
    expect(languageId('a.jsx')).toBe('javascriptreact');
    expect(languageId('a.rs')).toBe('rust');
    expect(languageId('a.py')).toBe('python');
    expect(languageId('a.go')).toBe('go');
    expect(languageId('a.unknownext')).toBe('unknownext');
    expect(languageId('Makefile')).toBe('plaintext');
  });

  it('round-trips paths through file:// URIs', () => {
    const uri = toUri('/tmp/foo/bar.ts');
    expect(uri.startsWith('file://')).toBe(true);
    expect(fromUri(uri)).toBe(path.relative(process.cwd(), '/tmp/foo/bar.ts'));
    expect(fromUri('https://example.com/x')).toBe('https://example.com/x');
  });

  it('normalizes LSP ranges to 1-indexed positions', () => {
    // Inputs are LSP-native (0-indexed); expected outputs are 1-indexed for Haze's display.
    expect(asRange({start: {line: 0, character: 2}, end: {line: 3, character: 5}})).toEqual({
      start: {line: 1, character: 3},
      end: {line: 4, character: 6},
    });
  });

  it('returns undefined when the value or its endpoints are not objects', () => {
    expect(asRange(null)).toBeUndefined();
    expect(asRange({start: null, end: null})).toBeUndefined();
    expect(asRange({start: {line: 0, character: 0}, end: 'bad'})).toBeUndefined();
  });

  it('defaults missing numeric range fields to 1', () => {
    const range = asRange({start: {}, end: {}});
    expect(range).toEqual({start: {line: 1, character: 1}, end: {line: 1, character: 1}});
  });

  it('converts location objects to relative paths', () => {
    const loc = locationToResult({uri: toUri('/tmp/foo/bar.ts'), range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}});
    expect(loc).toBeDefined();
    expect(loc?.range.start.line).toBe(1);
  });

  it('flattens hierarchical document symbols up to the limit', () => {
    const symbols = [
      {name: 'Top', kind: 12, range: {start: {line: 0, character: 0}, end: {line: 10, character: 0}}, selectionRange: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}, children: [
        {name: 'Inner', kind: 6, range: {start: {line: 1, character: 0}, end: {line: 2, character: 0}}, selectionRange: {start: {line: 1, character: 0}, end: {line: 1, character: 5}}},
      ]},
    ];
    expect(flattenSymbols(symbols, 'a.ts', 10).map(s => s.name)).toEqual(['Top', 'Inner']);
    expect(flattenSymbols(symbols, 'a.ts', 1).map(s => s.name)).toEqual(['Top']);
    expect(flattenSymbols(symbols, 'a.ts', 10)[0]?.path).toBe('a.ts');
  });

  it('skips symbol entries without a name', () => {
    expect(flattenSymbols([{kind: 1}, {name: 'Real'}], 'a.ts', 10).map(s => s.name)).toEqual(['Real']);
  });

  it('converts definition-style locations using targetUri', () => {
    const loc = locationToResult({targetUri: toUri('/tmp/foo/bar.ts'), targetSelectionRange: {start: {line: 2, character: 4}, end: {line: 2, character: 8}}});
    expect(loc).toBeDefined();
    expect(loc?.range.start.line).toBe(3);
  });
});

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

  it('sends shutdown + exit and kills the child on close', async () => {
    const child = fakeChild();
    const client = new StdioLspClient(ts, child);
    await client.close();
    const sent = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
    expect(sent.some(s => s.includes('"shutdown"'))).toBe(true);
    expect(sent.some(s => s.includes('"exit"'))).toBe(true);
    expect(child.killedBy).toBe('SIGTERM');
  });
});
