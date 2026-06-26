import {tool} from 'ai';
import {z} from 'zod';
import {reductionMetrics} from '../../core/toolOutput/reduction.js';
import {fetchUrlContent, BlockedUrlError} from '../webFetch.js';
import {structuredToolFailure} from './failures.js';
import {compactStoredOutput} from './outputCap.js';
import {runDedupedTool} from './toolContext.js';

const MAX_OUTPUT_CHARS = 50_000;

export const fetchTool = tool({
  description: 'Fetch a public http(s) URL and return readable content. Use for current docs, API references, error lookups, or CI logs. Private/loopback/metadata hosts are blocked.',
  inputSchema: z.object({
    url: z.string().url().describe('Absolute http(s) URL to fetch'),
    format: z.enum(['auto', 'text']).default('auto').describe('auto = markdown for HTML, pretty for JSON, passthrough for text; text = raw text only'),
  }),
  execute: async ({url, format}, context) => runDedupedTool('fetch', {url, format}, context, async () => {
    try {
      const result = await fetchUrlContent(url, {signal: context.abortSignal, format});
      const capped = compactStoredOutput(result.content, MAX_OUTPUT_CHARS);
      const extractionMethod = format === 'text' ? 'text' as const : result.extractionMethod;
      const fetchMetrics = reductionMetrics(result.content, capped.text);
      return {
        ok: true,
        url: result.url,
        status: result.status,
        statusText: result.statusText,
        contentType: result.contentType,
        bytes: result.bytes,
        redirected: result.redirected,
        extractionMethod,
        truncated: capped.truncated,
        content: capped.text,
        reducerName: extractionMethod === 'markdown' ? 'web-html-extract' : 'web-content-cap',
        contentKind: 'web',
        lossy: capped.truncated || extractionMethod === 'markdown',
        parseTier: 'full',
        ...fetchMetrics,
        ...(capped.handle ? {handle: capped.handle, rawHandle: capped.handle, omittedChars: capped.omittedChars} : {omittedChars: 0}),
      };
    } catch (error) {
      const reasonCode = error instanceof BlockedUrlError ? 'blocked_url' as const : undefined;
      return structuredToolFailure('fetch', error, 'Check the URL is correct and public. Private/localhost/metadata hosts and non-http(s) schemes are blocked.', url, {reasonCode});
    }
  }),
});
