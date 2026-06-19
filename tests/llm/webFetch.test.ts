import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {fetchUrlContent, BlockedUrlError, extractContent} from '../../src/llm/webFetch.js';

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
