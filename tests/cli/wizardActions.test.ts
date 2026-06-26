import {describe, expect, it} from 'vitest';
import {providerActionSuggestions, lspActionSuggestions, mcpActionSuggestions, skillsActionSuggestions, mcpTransportSuggestions} from '../../src/cli/commands/wizardSuggestions.js';
import {COMMON_ACTIONS, LSP_ACTIONS, MCP_ACTIONS, MCP_TRANSPORTS, PROVIDER_ACTIONS, SKILL_ACTIONS} from '../../src/cli/commands/wizardActions.js';

describe('wizard action constants', () => {
  it('backs provider action suggestions', () => {
    const values = providerActionSuggestions({providers: [{name: 'p', url: 'http://localhost/v1', models: ['m']}]}, 'p').map(item => item.value);
    expect(values).toEqual([PROVIDER_ACTIONS.useProvider, PROVIDER_ACTIONS.addModels, PROVIDER_ACTIONS.setApiKey, PROVIDER_ACTIONS.removeModels, PROVIDER_ACTIONS.removeProvider]);
  });

  it('backs LSP and MCP action suggestions', () => {
    expect(lspActionSuggestions({lspServers: [{name: 'ts', command: 'typescript-language-server'}]}, 'ts').map(item => item.value)).toEqual([COMMON_ACTIONS.disable, LSP_ACTIONS.removeServer]);
    expect(mcpActionSuggestions({mcpServers: [{name: 'ctx', transport: 'http', url: 'https://example.com'}]}, 'ctx').map(item => item.value)).toEqual([COMMON_ACTIONS.disable, MCP_ACTIONS.setApiKey, MCP_ACTIONS.removeServer]);
  });

  it('backs MCP transport and skill action suggestions', () => {
    expect(mcpTransportSuggestions().map(item => item.value)).toEqual([MCP_TRANSPORTS.http, MCP_TRANSPORTS.sse, MCP_TRANSPORTS.stdio]);
    expect(skillsActionSuggestions({}, [{name: 's', description: 'skill', body: '', references: [], dir: '/tmp/s', path: '/tmp/s/SKILL.md', source: 'global'}], 's').map(item => item.value)).toEqual([COMMON_ACTIONS.disable, SKILL_ACTIONS.showInfo, SKILL_ACTIONS.validate, SKILL_ACTIONS.removeSkill]);
  });
});
