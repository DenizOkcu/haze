import {describe, expect, it} from 'vitest';
import {transitionMcpField, transitionProviderField} from '../../src/cli/commands/wizardTransition.js';

describe('wizard transition boundary', () => {
  it('emits provider draft, mode, and message effects at the submit boundary', () => {
    expect(transitionProviderField({mode: 'providerAddName', value: 'local', settings: {}})).toEqual([
      {type: 'provider-draft', patch: {name: 'local'}, replace: true},
      {type: 'mode', mode: 'providerAddUrl'},
      {type: 'message', text: 'OpenAI-compatible base URL? Example: https://openrouter.ai/api/v1 or http://localhost:1234/v1'},
    ]);
    expect(transitionProviderField({mode: 'providerAddKey', value: ' secret ', settings: {}})).toContainEqual({type: 'provider-draft', patch: {key: 'secret'}});
  });

  it('keeps invalid provider and MCP input in place with only an error effect', () => {
    expect(transitionProviderField({mode: 'providerAddUrl', value: 'not-a-url', settings: {}})).toEqual([{type: 'message', text: 'Enter a valid URL, for example http://localhost:1234/v1.'}]);
    expect(transitionMcpField({mode: 'mcpAddTransport', value: 'bogus', settings: {}, draft: {name: 'x'}})).toEqual([{type: 'message', text: 'Enter http, sse, or stdio.'}]);
  });

  it('turns stdio command capture directly into a finish effect without a key prompt', () => {
    const effects = transitionMcpField({mode: 'mcpAddCommand', value: 'node server.js', settings: {}, draft: {name: 'local', transport: 'stdio'}});
    expect(effects).toEqual([{type: 'finish-mcp-stdio', draft: {name: 'local', transport: 'stdio', command: 'node', args: ['server.js']}}]);
  });

  it('returns explicit state effects for remote MCP fields', () => {
    const effects = transitionMcpField({mode: 'mcpAddUrl', value: 'https://example.com/mcp', settings: {}, draft: {name: 'remote', transport: 'http'}});
    expect(effects).toContainEqual({type: 'mode', mode: 'mcpAddKey'});
    expect(effects).toContainEqual({type: 'mcp-draft', patch: {url: 'https://example.com/mcp'}});
  });
});
