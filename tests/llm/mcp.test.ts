import {describe, expect, it, beforeEach, vi} from 'vitest';
import type {Tool, ToolExecutionOptions, ToolSet} from 'ai';
import type {HazeMcpServer} from '../../src/config/settings.js';

// `vi.mock` factories run before top-level bindings initialise, so the mock fn
// must be created with `vi.hoisted` and referenced from the factory.
const mocks = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mocks.createMCPClient,
}));

import {closeMcpClients, loadMcpTools} from '../../src/llm/mcp.js';

function toolset(entries: Array<[string, string]>): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const [name, marker] of entries) tools[name] = {marker};
  return tools as unknown as ToolSet;
}

interface FakeClient {
  tools: () => Promise<ToolSet>;
  close: ReturnType<typeof vi.fn>;
}

function fakeClient(tools: ToolSet, closeImpl: () => unknown = () => undefined): FakeClient {
  return {tools: async () => tools, close: vi.fn(closeImpl)};
}

function httpServer(name: string): HazeMcpServer {
  return {name, transport: 'http', url: `https://${name}.example/mcp`};
}

function fakeExecutableTool(name: string, result: unknown): Tool {
  return {
    description: `tool ${name}`,
    parameters: {type: 'object', properties: {}},
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as Tool;
}

beforeEach(() => {
  mocks.createMCPClient.mockReset();
});

describe('loadMcpTools', () => {
  it('merges tools from multiple enabled servers and returns their clients', async () => {
    mocks.createMCPClient
      .mockReturnValueOnce(fakeClient(toolset([['alpha', 'a'], ['beta', 'b']])))
      .mockReturnValueOnce(fakeClient(toolset([['gamma', 'g']])));
    const result = await loadMcpTools([httpServer('s1'), httpServer('s2')]);
    expect(Object.keys(result.tools).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.errors).toEqual([]);
    expect(result.clients).toHaveLength(2);
  });

  it('never lets an MCP tool shadow a reserved (built-in) name', async () => {
    mocks.createMCPClient.mockReturnValueOnce(fakeClient(toolset([['readFile', 'mcp'], ['unique', 'mcp']])));
    const result = await loadMcpTools([httpServer('s1')], new Set(['readFile', 'bash']));
    expect(Object.keys(result.tools)).toEqual(['unique']);
    expect(result.errors).toContain('s1: skipped tool "readFile" (name already in use)');
  });

  it('skips a tool name that collides with an earlier server (first wins)', async () => {
    mocks.createMCPClient
      .mockReturnValueOnce(fakeClient(toolset([['shared', 'first'], ['onlyA', 'a']])))
      .mockReturnValueOnce(fakeClient(toolset([['shared', 'second']])));
    const result = await loadMcpTools([httpServer('s1'), httpServer('s2')]);
    expect(Object.keys(result.tools).sort()).toEqual(['onlyA', 'shared']);
    expect((result.tools.shared as {marker?: string}).marker).toBe('first');
    expect(result.errors).toContain('s2: skipped tool "shared" (name already in use)');
  });

  it('skips servers that are explicitly disabled', async () => {
    mocks.createMCPClient.mockReturnValue(fakeClient(toolset([['x', 'x']])));
    const result = await loadMcpTools([{...httpServer('off'), enabled: false}, httpServer('on')]);
    expect(Object.keys(result.tools)).toEqual(['x']);
    expect(result.clients).toHaveLength(1);
    expect(mocks.createMCPClient).toHaveBeenCalledTimes(1);
  });

  it('isolates a server whose client creation throws', async () => {
    mocks.createMCPClient
      .mockImplementationOnce(() => {
        throw new Error('connection refused');
      })
      .mockReturnValueOnce(fakeClient(toolset([['ok', 'ok']])));
    const result = await loadMcpTools([httpServer('broken'), httpServer('alive')]);
    expect(Object.keys(result.tools)).toEqual(['ok']);
    expect(result.errors.some(message => message.startsWith('broken:'))).toBe(true);
    expect(result.errors.some(message => message.includes('connection refused'))).toBe(true);
    expect(result.clients).toHaveLength(1);
  });

  it('isolates a server whose tools() rejects but keeps its client for closing', async () => {
    const failing: FakeClient = {tools: async () => Promise.reject(new Error('tools unavailable')), close: vi.fn()};
    mocks.createMCPClient
      .mockReturnValueOnce(failing)
      .mockReturnValueOnce(fakeClient(toolset([['ok', 'ok']])));
    const result = await loadMcpTools([httpServer('broken'), httpServer('alive')]);
    expect(Object.keys(result.tools)).toEqual(['ok']);
    expect(result.errors.some(message => message.includes('tools unavailable'))).toBe(true);
    // The failing client is pushed before tools() resolves, so it stays closable.
    expect(result.clients).toHaveLength(2);
  });

  it('reports a missing command for stdio servers before opening any transport', async () => {
    const result = await loadMcpTools([{name: 'stdio-nope', transport: 'stdio'}]);
    expect(Object.keys(result.tools)).toEqual([]);
    expect(result.errors.some(message => message.includes('missing command'))).toBe(true);
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });

  it('reports a missing url for remote transports', async () => {
    const result = await loadMcpTools([{name: 'nourl', transport: 'sse'}]);
    expect(result.errors.some(message => message.includes('missing url'))).toBe(true);
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });

  it('forwards configured headers to the MCP client', async () => {
    mocks.createMCPClient.mockReturnValueOnce(fakeClient(toolset([['docs', 'docs']])));
    await loadMcpTools([{name: 'ctx7', transport: 'http', url: 'https://mcp.context7.com/mcp', headers: [{name: 'Authorization', value: 'Bearer secret'}]}]);
    expect(mocks.createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({type: 'http', url: 'https://mcp.context7.com/mcp', headers: {Authorization: 'Bearer secret'}}),
      }),
    );
  });

  it('omits a headers object when the server has none', async () => {
    mocks.createMCPClient.mockReturnValueOnce(fakeClient(toolset([['docs', 'docs']])));
    await loadMcpTools([httpServer('plain')]);
    const arg = mocks.createMCPClient.mock.calls[0]?.[0] as {transport?: {headers?: unknown}};
    expect(arg.transport?.headers).toBeUndefined();
  });

  it('returns an empty result for no enabled servers', async () => {
    const result = await loadMcpTools([]);
    expect(result.tools).toEqual({});
    expect(result.clients).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('wraps string MCP tool results in an external-content envelope', async () => {
    const docsTool = fakeExecutableTool('docs', 'Context7 result');
    mocks.createMCPClient.mockReturnValueOnce(fakeClient({docs: docsTool} as unknown as ToolSet));
    const result = await loadMcpTools([httpServer('ctx7')]);
    const wrapped = result.tools.docs as Tool;
    const output = await wrapped.execute!({}, {} as ToolExecutionOptions);
    expect(output).toContain('<external-content type="mcp-tool" server="ctx7">');
    expect(output).toContain('Context7 result');
    expect(output).toContain('</external-content>');
  });

  it('serializes and wraps non-string MCP tool results', async () => {
    const docsTool = fakeExecutableTool('docs', {foo: 'bar'});
    mocks.createMCPClient.mockReturnValueOnce(fakeClient({docs: docsTool} as unknown as ToolSet));
    const result = await loadMcpTools([httpServer('ctx7')]);
    const wrapped = result.tools.docs as Tool;
    const output = await wrapped.execute!({}, {} as ToolExecutionOptions);
    expect(output).toContain('<external-content type="mcp-tool" server="ctx7">');
    expect(output).toContain('"foo": "bar"');
    expect(output).toContain('</external-content>');
  });
});

describe('closeMcpClients', () => {
  it('closes every client and never rejects', async () => {
    const good = vi.fn(async () => undefined);
    const bad = vi.fn(async () => {
      throw new Error('close failed');
    });
    await expect(closeMcpClients([{close: good}, {close: bad}] as Array<{close: () => Promise<void>}>)).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('handles an empty client list', async () => {
    await expect(closeMcpClients([])).resolves.toBeUndefined();
  });
});
