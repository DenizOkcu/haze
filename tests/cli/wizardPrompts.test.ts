import {describe, expect, it} from 'vitest';
import {captureLspName, captureMcpCommand, captureMcpName, captureMcpTransport, captureMcpUrl, captureProviderName, captureProviderUrl} from '../../src/cli/commands/wizardPrompts.js';

describe('wizard capture helpers', () => {
  it('validates provider names and uniqueness', () => {
    expect(captureProviderName({}, '  ').message).toMatch(/required/);
    expect(captureProviderName({providers: [{name: 'a', url: 'x', models: []}]}, 'a').message).toMatch(/already exists/);
    expect(captureProviderName({}, 'new').nextMode).toBe('providerAddUrl');
  });

  it('validates LSP names and uniqueness', () => {
    expect(captureLspName({lspServers: [{name: 'a', command: 'x'}]}, 'a').message).toMatch(/already exists/);
    expect(captureLspName({}, 'ts').draft).toEqual({name: 'ts'});
  });

  it('validates MCP names', () => {
    expect(captureMcpName({mcpServers: [{name: 'a', transport: 'http', url: 'x'}]}, 'a').message).toMatch(/already exists/);
    expect(captureMcpName({}, 'ctx').nextMode).toBe('mcpAddTransport');
  });

  it('parses URLs and rejects invalid ones', () => {
    expect(captureProviderUrl('not a url').message).toMatch(/valid URL/);
    expect(captureProviderUrl('http://localhost:1234/v1').nextMode).toBe('providerAddKey');
    expect(captureMcpUrl('https://mcp.example.com/mcp').draft?.url).toBe('https://mcp.example.com/mcp');
  });

  it('selects transport and command handlers', () => {
    expect(captureMcpTransport('bogus').message).toMatch(/http, sse, or stdio/);
    expect(captureMcpTransport('stdio').nextMode).toBe('mcpAddCommand');
    expect(captureMcpTransport('http').nextMode).toBe('mcpAddUrl');
    expect(captureMcpCommand(' ').message).toMatch(/required/);
    expect(captureMcpCommand('node x.js').draft).toEqual({command: 'node', args: ['x.js']});
  });
});