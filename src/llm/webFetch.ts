import {validateUrl, type UrlValidation} from '../core/safety/urlGuard.js';

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
}

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

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<{text: string; bytes: number; truncated: boolean}> {
  const body = response.body;
  if (body == null || typeof (body as {getReader?: unknown}).getReader !== 'function') {
    // No streamable body; read as text once and cap.
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      return {text: text.slice(0, maxBytes), bytes: maxBytes, truncated: true};
    }
    return {text, bytes, truncated: false};
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let received = 0;
  let truncated = false;

  try {
    // Stream with a byte counter; stop and mark truncated once the ceiling is hit.
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      const chunkBytes = value.byteLength;
      received += chunkBytes;
      if (received > maxBytes) {
        const already = received - chunkBytes;
        const remaining = Math.max(0, maxBytes - already);
        if (remaining > 0) text += decoder.decode(value.slice(0, remaining), {stream: true});
        text += decoder.decode();
        truncated = true;
        try { reader.cancel(); } catch { /* ignore */ }
        break;
      }
      text += decoder.decode(value, {stream: true});
    }
    if (!truncated) text += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    // If we hit the cap, abort the fetch to free the underlying connection.
    if (truncated && !abortController.signal.aborted) abortController.abort();
  }

  return {text, bytes: Math.min(received, maxBytes), truncated};
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

  const initial = await validateUrl(input);
  if (!initial.ok) throw new BlockedUrlError(initial);

  let currentUrl: URL = initial.url;
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
      response = await fetch(currentUrl, {
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
      const redirectValidation = await validateUrl(nextUrl.href);
      if (!redirectValidation.ok) throw new BlockedUrlError(redirectValidation);
      if (visited.includes(nextUrl.href)) {
        throw new Error(`Redirect loop detected fetching ${input}`);
      }
      visited.push(currentUrl.href);
      currentUrl = nextUrl;
      continue;
    }
    break;
  }

  if (!response) throw new Error(`No response fetching ${input}`);

  // Belt-and-suspenders: re-validate the final URL after redirects.
  const finalValidation = await validateUrl(currentUrl.href);
  if (!finalValidation.ok) throw new BlockedUrlError(finalValidation);

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
