import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {validateUrl, type UrlValidation, type DnsLookupFn} from '../core/safety/urlGuard.js';

/**
 * Bounded HTTP fetch + content extraction for the `fetch` tool.
 *
 * We own the HTTP request (not the extraction library) so we can enforce:
 *  - SSRF guards (scheme allowlist + private/loopback/link-local blocking),
 *    re-validated on every redirect hop and after DNS resolution;
 *  - a raw-download size ceiling (streamed, never buffered unbounded);
 *  - a timeout via AbortSignal;
 *  - a redirect cap.
 *
 * HTML → Markdown extraction uses `defuddle/node` (readability-grade main
 * content extraction, backed by `linkedom` + `turndown`). A minimal tag-strip
 * fallback ensures a malformed page never breaks the tool.
 */

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  format?: 'auto' | 'text';
  /** @internal custom DNS resolver forwarded to validateUrl (testing seam). */
  lookup?: DnsLookupFn;
  /** @internal transport override (testing seam); defaults to pinnedFetch. */
  fetcher?: PinnedFetcher;
}

/**
 * Transport signature: fetch `url`, pinning the TCP connection to `pinnedIp`
 * when set (hostname URL whose DNS was already resolved and validated by the
 * caller). When `pinnedIp` is undefined (literal-IP URL), the transport falls
 * back to the global fetch — no DNS-rebinding surface exists for a literal IP.
 */
export type PinnedFetcher = (
  url: URL,
  pinnedIp: string | undefined,
  init: RequestInit,
) => Promise<Response>;

export interface FetchResult {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  redirected: boolean;
  content: string;
  extractionMethod: 'markdown' | 'json' | 'text';
  truncated: boolean;
}

export type {UrlValidation};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = 'Haze/0.5 (+https://github.com/DenizOkcu/haze)';

/** Error thrown when a URL is rejected by the SSRF guard. */
export class BlockedUrlError extends Error {
  reasonCode: 'blocked_url';
  validation: UrlValidation;
  constructor(validation: UrlValidation) {
    const reason = !validation.ok ? validation.reason : 'URL blocked';
    super(reason);
    this.name = 'BlockedUrlError';
    this.reasonCode = 'blocked_url';
    this.validation = validation;
  }
}

/** Minimal fallback HTML→text when defuddle fails on malformed input. */
function fallbackStripTags(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract readable content from an HTML string. Returns markdown via defuddle
 * when possible, falling back to a tag strip. Also surfaces the page title so
 * the tool can prefix the content.
 */
export async function extractContent(html: string, url: string): Promise<{content: string; title?: string}> {
  try {
    const {Defuddle} = await import('defuddle/node');
    const result = await Defuddle(html, url, {markdown: true, useAsync: false});
    const content = typeof result.content === 'string' && result.content.trim().length > 0
      ? result.content
      : fallbackStripTags(html);
    const title = typeof result.title === 'string' && result.title.trim().length > 0 ? result.title.trim() : undefined;
    return {content, title};
  } catch {
    return {content: fallbackStripTags(html)};
  }
}

function prettyJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return undefined;
  }
}

function classifyContentType(contentType: string): 'json' | 'html' | 'text' {
  const ct = contentType.toLowerCase();
  if (ct.includes('json') || ct.includes('+json')) return 'json';
  if (ct.includes('html') || ct.includes('xhtml')) return 'html';
  return 'text';
}

function decodeValidUtf8Prefix(buffer: Buffer): string {
  for (let end = buffer.byteLength; end >= 0; end--) {
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, end));
    } catch {
      // Back up until we land on a UTF-8 character boundary.
    }
  }
  return '';
}

function truncateUtf8Bytes(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return {text, bytes: buffer.byteLength, truncated: false};
  return {text: decodeValidUtf8Prefix(buffer.subarray(0, maxBytes)), bytes: maxBytes, truncated: true};
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<{text: string; bytes: number; truncated: boolean}> {
  const body = response.body;
  if (body == null || typeof (body as {getReader?: unknown}).getReader !== 'function') {
    // No streamable body; read as text once and cap.
    return truncateUtf8Bytes(await response.text(), maxBytes);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let kept = 0;
  let truncated = false;

  try {
    // Stream with a byte counter; keep only bytes up to the ceiling and stop once hit.
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.byteLength;
      const remaining = Math.max(0, maxBytes - kept);
      if (remaining > 0) {
        const slice = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
        chunks.push(slice);
        kept += slice.byteLength;
      }
      if (received > maxBytes) {
        truncated = true;
        try { reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    // If we hit the cap, abort the fetch to free the underlying connection.
    if (truncated && !abortController.signal.aborted) abortController.abort();
  }

  return {text: decodeValidUtf8Prefix(Buffer.concat(chunks)), bytes: Math.min(received, maxBytes), truncated};
}

/**
 * Perform an HTTP(S) request with the TCP connection pinned to `pinnedIp`.
 *
 * This closes the DNS-rebinding TOCTOU: `validateUrl` resolved the hostname and
 * verified every address is public, but the global `fetch` would re-resolve the
 * hostname at connect time — an attacker-controlled DNS server can return a
 * public IP for the validation lookup and a private/internal IP for the connect
 * lookup. By connecting directly to the already-validated IP (`hostname:
 * pinnedIp`) while keeping the original `Host` header and TLS `servername`
 * (`url.hostname`), the connection target is fixed to what we validated, with no
 * second DNS lookup. TLS certificate verification still runs against the original
 * hostname via `servername`, so pinning does not weaken identity checks.
 *
 * Literal-IP URLs carry no DNS-rebinding surface (`pinnedIp` is undefined), so
 * they fall through to the global `fetch` — which also keeps the test mocks that
 * stub `globalThis.fetch` working for that path.
 */
/**
 * Coerce a RequestInit headers value into a plain string record. Keeps the
 * transport defensive against `Headers`/tuple/array inputs instead of blindly
 * casting (the fetch tool only ever passes a plain object, but be safe).
 */
function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {};
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length === 2) out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return {...(input as Record<string, string>)};
}

export async function pinnedFetch(url: URL, pinnedIp: string | undefined, init: RequestInit): Promise<Response> {
  if (!pinnedIp) return globalThis.fetch(url, init);

  const isTls = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : (isTls ? 443 : 80);
  const path = url.pathname + url.search;
  const headers = normalizeHeaders(init.headers);
  // Preserve the original host in the request line; node would otherwise send
  // the pinned IP as the Host header.
  headers.host = url.host;
  const lib = isTls ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const req = lib.request(
      {
        method: init.method ?? 'GET',
        hostname: pinnedIp,
        port,
        path,
        headers,
        ...(isTls ? {servername: url.hostname, rejectUnauthorized: true} : {}),
        signal: init.signal as AbortSignal | undefined,
      },
      (res) => {
        const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, {
          status: res.statusCode ?? 200,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string>,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch a public http(s) URL and return readable content.
 *
 * Non-2xx responses are still returned (with status text in the content) so the
 * model can see e.g. a 404 message; only network errors, aborts, and SSRF
 * rejections throw.
 */
export async function fetchUrlContent(input: string, opts?: FetchOptions): Promise<FetchResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetcher = opts?.fetcher ?? pinnedFetch;
  const validateOpts = opts?.lookup ? {lookup: opts.lookup} : undefined;

  const initial = await validateUrl(input, validateOpts);
  if (!initial.ok) throw new BlockedUrlError(initial);

  let currentUrl: URL = initial.url;
  // Pin the connection to the address we just validated — the validated IP
  // flows from validateUrl straight into the transport, with no second DNS
  // lookup in between (that gap was the rebinding window).
  let currentPinnedIp: string | undefined = initial.resolvedAddresses?.[0];
  let response: Response | undefined;
  const visited: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) abortController.abort();
      else opts.signal.addEventListener('abort', onAbort, {once: true});
    }
    const combined = AbortSignal.any([timeoutSignal, abortController.signal]);

    try {
      response = await fetcher(currentUrl, currentPinnedIp, {
        redirect: 'manual',
        signal: combined,
        headers: {accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.5,*/*;q=0.1', 'user-agent': USER_AGENT},
      });
    } catch (error) {
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      if (abortController.signal.aborted && !timeoutSignal.aborted) {
        // Aborted by caller or size cap; surface a clear error.
        throw error;
      }
      throw error;
    } finally {
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
    }

    // Follow redirects ourselves, re-validating each Location (closes the
    // redirect-to-internal-IP hole).
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      if (hop >= maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects}) fetching ${input}`);
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`Invalid redirect Location '${location}'`);
      }
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new BlockedUrlError({ok: false, reasonCode: 'blocked_scheme', reason: `Redirect to non-http(s) scheme '${nextUrl.protocol}' is blocked.`});
      }
      const redirectValidation = await validateUrl(nextUrl.href, validateOpts);
      if (!redirectValidation.ok) throw new BlockedUrlError(redirectValidation);
      if (visited.includes(nextUrl.href)) {
        throw new Error(`Redirect loop detected fetching ${input}`);
      }
      visited.push(currentUrl.href);
      currentUrl = nextUrl;
      currentPinnedIp = redirectValidation.resolvedAddresses?.[0];
      continue;
    }
    break;
  }

  if (!response) throw new Error(`No response fetching ${input}`);

  // No post-fetch re-validation: every hop (including the final response) was
  // validated and connection-pinned at fetch time. Re-resolving the final URL
  // here would only reopen a rebinding race against a connection that already
  // used a safe, pinned IP.

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', onAbort, {once: true});
  }
  let bodyResult: {text: string; bytes: number; truncated: boolean};
  try {
    bodyResult = await readBodyCapped(response, maxBytes, abortController);
  } finally {
    if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const kind = classifyContentType(contentType);
  let content = bodyResult.text;
  let extractionMethod: FetchResult['extractionMethod'];

  if (response.ok || response.status === 304) {
    if (opts?.format === 'text') {
      extractionMethod = 'text';
    } else if (kind === 'json') {
      const pretty = prettyJson(bodyResult.text);
      if (pretty !== undefined) {
        content = pretty;
        extractionMethod = 'json';
      } else {
        extractionMethod = 'text';
      }
    } else if (kind === 'html') {
      const extracted = await extractContent(bodyResult.text, currentUrl.href);
      const titlePrefix = extracted.title ? `# ${extracted.title}\n\n` : '';
      content = `${titlePrefix}${extracted.content}`;
      extractionMethod = 'markdown';
    } else {
      extractionMethod = 'text';
    }
  } else {
    const statusText = response.statusText || `HTTP ${response.status}`;
    content = `[${response.status} ${statusText}] ${bodyResult.text}`.trim();
    extractionMethod = 'text';
  }

  return {
    url: currentUrl.href,
    status: response.status,
    statusText: response.statusText,
    contentType,
    bytes: bodyResult.bytes,
    redirected: currentUrl.href !== initial.url.href,
    content,
    extractionMethod,
    truncated: bodyResult.truncated,
  };
}
