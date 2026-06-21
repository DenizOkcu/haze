import {createMCPClient, type MCPClient} from '@ai-sdk/mcp';
import type {ToolSet} from 'ai';
import type {HazeMcpServer} from '../config/settings.js';

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
export async function loadMcpTools(servers: HazeMcpServer[], reserved: ReadonlySet<string> = new Set()): Promise<LoadedMcpTools> {
  const enabled = servers.filter(server => server.enabled !== false);
  const tools: ToolSet = {};
  const clients: MCPClient[] = [];
  const errors: string[] = [];
  const taken = new Set(reserved);

  for (const server of enabled) {
    try {
      const client = await createMcpClient(server);
      clients.push(client);
      const serverTools = await client.tools();
      for (const [name, toolDef] of Object.entries(serverTools)) {
        if (taken.has(name)) {
          errors.push(`${server.name}: skipped tool "${name}" (name already in use)`);
          continue;
        }
        taken.add(name);
        tools[name] = toolDef;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${server.name}: ${message}`);
    }
  }

  return {tools, clients, errors};
}

async function createMcpClient(server: HazeMcpServer): Promise<MCPClient> {
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('missing command for stdio transport');
    const {Experimental_StdioMCPTransport} = await import('@ai-sdk/mcp/mcp-stdio');
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({command: server.command, args: server.args ?? []}),
    });
  }

  if (!server.url) throw new Error(`missing url for ${server.transport} transport`);
  const headers = headersToRecord(server);
  return createMCPClient({
    transport: {type: server.transport, url: server.url, ...(headers ? {headers} : {})},
  });
}

/** Close all MCP clients opened during a turn. Never throws. */
export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map(client => client.close()));
}
