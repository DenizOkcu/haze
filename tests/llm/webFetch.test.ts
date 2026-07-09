import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {fetchUrlContent, BlockedUrlError, extractContent, pinnedFetch} from '../../src/llm/webFetch.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  });
}

function htmlResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {status: 200, headers: {'content-type': 'text/html; charset=utf-8', ...headers}});
}

function textResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {status: 200, headers: {'content-type': 'text/plain; charset=utf-8', ...headers}});
}

function streamResponse(chunks: Uint8Array[], maxBytes: number, contentType = 'text/plain') {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const encoder = new TextEncoder();
  let produced = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks.length === 0) {
        controller.close();
        return;
      }
      const chunk = chunks.shift()!;
      produced += chunk.length;
      controller.enqueue(chunk);
      if (produced >= total) controller.close();
    },
  });
  return new Response(stream, {status: 200, headers: {'content-type': contentType}});
}

describe('webFetch fetchUrlContent', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Stub the DNS resolver indirectly: validateUrl resolves real hostnames via
    // real DNS in these tests; use well-known public hostnames + IPs to keep
    // tests deterministic without mocking DNS.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('pretty-prints JSON responses', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({'b': 2, 'a': 1})) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/api');
    expect(result.extractionMethod).toBe('json');
    expect(result.content).toBe('{\n  "b": 2,\n  "a": 1\n}');
    expect(result.status).toBe(200);
  });

  it('falls back to text when JSON is invalid', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse('not-json{')) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/api');
    expect(result.extractionMethod).toBe('text');
    expect(result.content).toBe('not-json{');
  });

  it('passes through plain text', async () => {
    globalThis.fetch = vi.fn(async () => textResponse('hello world\n')) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/readme.txt');
    expect(result.extractionMethod).toBe('text');
    expect(result.content).toBe('hello world\n');
  });

  it('extracts markdown from HTML, dropping nav/footer', async () => {
    const html = '<html><head><title>Docs Page</title></head><body>'
      + '<nav><ul><li>HOME</li><li>ABOUT</li></ul></nav>'
      + '<article><h1>Title</h1><p>Main <strong>content</strong> body.</p></article>'
      + '<footer>FOOTER COPYRIGHT</footer></body></html>';
    globalThis.fetch = vi.fn(async () => htmlResponse(html)) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/docs');
    expect(result.extractionMethod).toBe('markdown');
    expect(result.content).toContain('# Docs Page');
    expect(result.content).toContain('Main');
    expect(result.content).not.toMatch(/HOME|ABOUT/);
    expect(result.content).not.toMatch(/FOOTER COPYRIGHT/);
  });

  it('aborts and marks truncated when the body exceeds maxBytes', async () => {
    const big = new TextEncoder().encode('x'.repeat(10_000));
    globalThis.fetch = vi.fn(async () => streamResponse([big], 10_000)) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/big', {maxBytes: 5000});
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(5000);
  }, 10_000);

  it('caps non-streaming bodies by bytes, not UTF-16 characters', async () => {
    globalThis.fetch = vi.fn(async () => textResponse('é'.repeat(10))) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/unicode', {maxBytes: 5});
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(5);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(5);
  });

  it('follows redirects and re-validates the target', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      calls++;
      const target = typeof input === 'string' ? input : input.toString();
      if (target === 'https://93.184.216.34/start') {
        return new Response(null, {status: 302, headers: {location: 'https://93.184.216.34/dest'}});
      }
      return textResponse('arrived');
    }) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/start');
    expect(result.redirected).toBe(true);
    expect(result.content).toBe('arrived');
    expect(result.url).toBe('https://93.184.216.34/dest');
    expect(calls).toBe(2);
  });

  it('blocks a redirect to a metadata address', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, {status: 302, headers: {location: 'http://169.254.169.254/latest/meta-data/'}})) as typeof globalThis.fetch;
    await expect(fetchUrlContent('https://93.184.216.34/start')).rejects.toMatchObject({name: 'BlockedUrlError'});
  });

  it('blocks a redirect to a non-http scheme', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, {status: 302, headers: {location: 'file:///etc/passwd'}})) as typeof globalThis.fetch;
    await expect(fetchUrlContent('https://93.184.216.34/start')).rejects.toMatchObject({name: 'BlockedUrlError'});
  });

  it('reports non-2xx status in the content without throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', {status: 404, headers: {'content-type': 'text/plain'}})) as typeof globalThis.fetch;
    const result = await fetchUrlContent('https://93.184.216.34/missing');
    expect(result.status).toBe(404);
    expect(result.content).toContain('404');
    expect(result.content).toContain('Not Found');
  });

  it('throws BlockedUrlError for a blocked address', async () => {
    await expect(fetchUrlContent('http://169.254.169.254/')).rejects.toMatchObject({name: 'BlockedUrlError'});
  });

  it('throws BlockedUrlError for a blocked scheme', async () => {
    await expect(fetchUrlContent('file:///etc/passwd')).rejects.toMatchObject({name: 'BlockedUrlError'});
  });

  it('rejects when fetch errors', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch;
    await expect(fetchUrlContent('https://93.184.216.34/x')).rejects.toThrow('fetch failed');
  });

  it('aborts on timeout for a never-resolving fetch', async () => {
    globalThis.fetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
    })) as typeof globalThis.fetch;
    await expect(fetchUrlContent('https://93.184.216.34/slow', {timeoutMs: 50})).rejects.toThrow();
  }, 5_000);
});

describe('webFetch extractContent', () => {
  it('extracts article text and title from clean HTML', async () => {
    const html = '<html><head><title>Article</title></head><body><article><h1>Hi</h1><p>Body text here.</p></article></body></html>';
    const result = await extractContent(html, 'https://example.com/a');
    expect(result.title).toBe('Article');
    expect(result.content).toContain('Body text here');
  });

  it('returns stripped text even for minimal/odd HTML', async () => {
    const result = await extractContent('<div>plain<div>words</div></div>', 'https://example.com/b');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).not.toContain('<');
  });
});

describe('webFetch DNS-rebinding pinning', () => {
  it('pins the connection to the validated IP and does not re-resolve at fetch time', async () => {
    // A rebinding DNS server: public IP on the first (validation) lookup,
    // metadata IP on any subsequent lookup. The transport must connect to the
    // pinned (first) IP, never re-resolving — so the rebinding never lands.
    let lookupCalls = 0;
    const lookup = vi.fn(async () => {
      lookupCalls++;
      return lookupCalls === 1 ? ['93.184.216.34'] : ['169.254.169.254'];
    });
    let capturedPinnedIp: string | undefined;
    const fetcher = vi.fn(async (url: URL, pinnedIp: string | undefined) => {
      capturedPinnedIp = pinnedIp;
      return textResponse('ok');
    });
    const result = await fetchUrlContent('http://rebind.example/x', {lookup, fetcher});
    expect(lookup).toHaveBeenCalledTimes(1); // no second DNS lookup at connect time
    expect(capturedPinnedIp).toBe('93.184.216.34'); // pinned to the validated IP, not the rebound one
    expect(result.content).toBe('ok');
  });

  it('does not pin for a literal-IP URL (pinnedIp is undefined)', async () => {
    const fetcher = vi.fn(async (_url: URL, _pinnedIp: string | undefined) => textResponse('ip-path'));
    const result = await fetchUrlContent('https://93.184.216.34/api', {fetcher});
    // Literal IPs carry no rebinding surface: the transport gets no pinned IP.
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), undefined, expect.anything());
    expect(result.content).toBe('ip-path');
  });

  it('re-pins on each redirect hop to the new target', async () => {
    const seen: Array<{url: string; pinnedIp: string | undefined}> = [];
    const fetcher = vi.fn(async (url: URL, pinnedIp: string | undefined) => {
      seen.push({url: url.href, pinnedIp});
      if (url.href === 'http://start.example/') {
        return new Response(null, {status: 302, headers: {location: 'http://dest.example/d'}});
      }
      return textResponse('arrived');
    });
    const lookup = vi.fn(async (host: string) => {
      // Different public IP per host, both validated.
      return host === 'start.example' ? ['1.1.1.1'] : ['2.2.2.2'];
    });
    const result = await fetchUrlContent('http://start.example/', {lookup, fetcher});
    expect(result.content).toBe('arrived');
    expect(seen[0]).toEqual({url: 'http://start.example/', pinnedIp: '1.1.1.1'});
    expect(seen[1]).toEqual({url: 'http://dest.example/d', pinnedIp: '2.2.2.2'});
  });
});

describe('webFetch pinnedFetch transport', () => {
  let server: http.Server;
  let port: number;
  let receivedHost: string | undefined;
  let receivedPath: string | undefined;

  beforeEach(async () => {
    receivedHost = undefined;
    receivedPath = undefined;
    server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      receivedPath = req.url;
      res.writeHead(200, {'content-type': 'text/plain'});
      res.end('reached-pinned-server');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.close();
  });

  it('connects to the pinned IP while preserving the original Host header', async () => {
    // The URL hostname is a name that does not resolve; the connection must
    // still succeed because it is pinned to 127.0.0.1 (where our server listens).
    const url = new URL(`http://example.invalid:${port}/docs?q=1`);
    const res = await pinnedFetch(url, '127.0.0.1', {
      headers: {accept: 'text/plain', 'user-agent': 'test'},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('reached-pinned-server');
    // The server received the original hostname in the Host header and the
    // original path — proving the request line was not rewritten to the IP.
    expect(receivedHost).toBe(`example.invalid:${port}`);
    expect(receivedPath).toBe('/docs?q=1');
  });

  it('falls back to global fetch when no pinned IP is given', async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = vi.fn(async () => {
      called = true;
      return textResponse('global');
    }) as typeof globalThis.fetch;
    try {
      const res = await pinnedFetch(new URL('http://93.184.216.34/x'), undefined, {headers: {}});
      expect(called).toBe(true);
      expect(await res.text()).toBe('global');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects with a connection error for an unreachable https pinned target', async () => {
    // Bind + immediately close to obtain a guaranteed-refused port, then pin an
    // https request at it. Exercises the TLS branch (servername set) and the
    // error path without needing a real TLS cert.
    const probe = http.createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    const url = new URL(`https://example.invalid:${freePort}/secure`);
    await expect(pinnedFetch(url, '127.0.0.1', {headers: {}})).rejects.toThrow();
  });
});
