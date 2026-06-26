import {tool} from 'ai';
import {z} from 'zod';
import {readToolOutput as readStoredToolOutput} from '../../core/agent/toolOutputStore.js';

export const readToolOutputTool = tool({
  description: 'Read another page of oversized output previously returned by a tool handle.',
  inputSchema: z.object({
    handle: z.string().min(1).describe('Output handle from a prior tool result'),
    offset: z.number().int().nonnegative().default(0).describe('Character offset to start reading'),
    limit: z.number().int().positive().max(20_000).default(12_000).describe('Maximum characters to return'),
    query: z.string().optional().describe('Optional case-insensitive substring search within the stored output instead of reading by offset'),
    contextLines: z.number().int().nonnegative().max(20).default(2).describe('Lines of context around query matches'),
  }),
  execute: async ({handle, offset, limit, query, contextLines}) => {
    const page = readStoredToolOutput(handle, offset, limit, {query, contextLines});
    return page ?? {ok: false, error: `Unknown or expired tool output handle: ${handle}`};
  },
});
