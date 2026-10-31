import {createMCPClient, type MCPClient} from '@ai-sdk/mcp';
import type {ToolSet} from 'ai';
import type {HazeMcpServer} from '../config/settings.js';
import {assertCredentialedEndpointSecure} from '../config/endpointSecurity.js';
import {storeToolOutput, wrapUntrustedOutput, type StoredOutputOrigin} from '../core/agent/toolOutputStore.js';
import {MAX_MCP_OUTPUT_CHARS} from '../core/limits.js';

const MCP_DISCOVERY_TIMEOUT_MS = 10_000;
const MCP_CLOSE_TIMEOUT_MS = 2_000;
const MCP_DISCOVERY_CONCURRENCY = 4;
/** Bounded head of an oversized MCP result kept model-visible; the rest lives behind the handle. */
const MCP_OVERSIZED_PREVIEW_CHARS = 2_000;

/**
 * Wrap one MCP tool's execute with an output-size cap (HZA-2): a result whose
 * serialized size exceeds `MAX_MCP_OUTPUT_CHARS` is stored behind a
 * readToolOutput handle and the model-visible value becomes a bounded,
 * explicitly untrusted `<mcp_result>` payload, so a hostile server can neither
 * flood the context nor deliver unlabeled instructions. The stored entry
 * carries its mcp origin so every later readToolOutput page re-wraps in the
 * same envelope instead of returning raw unlabeled text.
 */
function wrapMcpToolExecute(serverName: string, toolName: string, toolDef: ToolSet[string]): ToolSet[string] {
  const execute = toolDef.execute;
  if (!execute) return toolDef;
  return {
    ...toolDef,
    execute: async (input, options) => {
      const result = await execute(input, options);
      let text: string;
      try {
        text = JSON.stringify(result) ?? String(result);
      } catch {
        text = String(result);
      }
      if (text.length <= MAX_MCP_OUTPUT_CHARS) return result;
      const origin: StoredOutputOrigin = {kind: 'mcp', server: serverName, toolName};
      const handle = storeToolOutput(text, origin);
      const payload = `${text.slice(0, MCP_OVERSIZED_PREVIEW_CHARS)}\n[... ${text.length - MCP_OVERSIZED_PREVIEW_CHARS} characters omitted; use readToolOutput with handle ${handle} ...]`;
      return {
        ok: false,
        server: serverName,
        toolName,
        reasonCode: 'mcp_result_oversized' as const,
        recoverable: true,
        error: `MCP tool "${toolName}" on server "${serverName}" returned ${text.length} characters (cap ${MAX_MCP_OUTPUT_CHARS}); the full result is stored behind a handle.`,
        suggestedNextStep: `Use readToolOutput with handle ${handle} to page through the parts of the result you need.`,
        rawChars: text.length,
        handle,
        content: wrapUntrustedOutput(origin, payload),
      };
    },
  };
}

function timeout<T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${milliseconds}ms`))), milliseconds);
    const abort = () => finish(() => reject(new Error('MCP discovery aborted')));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, {once: true});
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export interface LoadedMcpTools {
  tools: ToolSet;
  clients: MCPClient[];
  errors: string[];
}

function headersToRecord(server: HazeMcpServer): Record<string, string> | undefined {
  if (!server.headers || server.headers.length === 0) return undefined;
  const record: Record<string, string> = {};
  for (const header of server.headers) record[header.name] = header.value;
  return record;
}

/**
 * Connect to each enabled MCP server, discover its tools, and merge them into a
 * single toolset. Tool names that collide with `reserved` or with an earlier
 * server's tools are skipped (reported in `errors`) so MCP servers can never
 * shadow built-in tools. A failing server is isolated: its error is collected
 * and the remaining servers still load. Returns the tools, the live clients
 * (for `.close()` after the turn), and any per-server error messages.
 */
export async function loadMcpTools(servers: HazeMcpServer[], reserved: ReadonlySet<string> = new Set(), signal?: AbortSignal): Promise<LoadedMcpTools> {
  const enabled = servers.filter(server => server.enabled !== false);
  const tools: ToolSet = {};
  const clients: MCPClient[] = [];
  const errors: string[] = [];
  const taken = new Set(reserved);
  const discovered = await mapConcurrent(enabled, MCP_DISCOVERY_CONCURRENCY, async server => {
    if (signal?.aborted) return {server, error: 'MCP discovery aborted'};
    let client: MCPClient | undefined;
    const creating = createMcpClient(server).then(value => { client = value; return value; });
    try {
      const activeClient = await timeout(creating, MCP_DISCOVERY_TIMEOUT_MS, signal);
      const serverTools = await timeout(activeClient.tools(), MCP_DISCOVERY_TIMEOUT_MS, signal);
      return {server, client: activeClient, serverTools};
    } catch (error) {
      if (!client) void creating.then(late => closeMcpClients([late])).catch(() => undefined);
      else await closeMcpClients([client]);
      return {server, error: error instanceof Error ? error.message : String(error)};
    }
  });
  for (const result of discovered) {
    if ('error' in result) { errors.push(`${result.server.name}: ${result.error}`); continue; }
    clients.push(result.client);
    for (const [name, toolDef] of Object.entries(result.serverTools)) {
      if (taken.has(name)) { errors.push(`${result.server.name}: skipped tool "${name}" (name already in use)`); continue; }
      // MCP tool schemas are discovered at runtime. The MCP package's schema
      // generic is wider than the core AI SDK ToolSet generic, although both
      // expose the same runtime tool contract here.
      taken.add(name); tools[name] = wrapMcpToolExecute(result.server.name, name, toolDef as ToolSet[string]);
    }
  }
  return {tools, clients, errors};
}

/**
 * Transport-dispatching wrapper around `createMCPClient` (imported from
 * `@ai-sdk/mcp`, capitalised). Translates a `HazeMcpServer` config into the
 * transport shape the SDK expects — stdio (via `Experimental_StdioMCPTransport`)
 * vs HTTP/SSE — and validates required fields before opening a transport.
 *
 * Not dead code: `loadMcpTools` calls this lowercase wrapper, not the imported
 * `createMCPClient` directly (the import cannot take a `HazeMcpServer`).
 */
async function createMcpClient(server: HazeMcpServer): Promise<MCPClient> {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('missing command for stdio transport');
    const {Experimental_StdioMCPTransport} = await import('@ai-sdk/mcp/mcp-stdio');
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({command: server.command, args: server.args ?? []}),
    });
  }

  if (!server.url) throw new Error(`missing url for ${server.transport} transport`);
  assertCredentialedEndpointSecure(server.url, server.headers);
  const headers = headersToRecord(server);
  return createMCPClient({
    transport: {type: server.transport, url: server.url, ...(headers ? {headers} : {})},
  });
}

/** Close all MCP clients opened during a turn. Never throws. */
export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map(client => timeout(Promise.resolve(client.close()), MCP_CLOSE_TIMEOUT_MS)));
}
