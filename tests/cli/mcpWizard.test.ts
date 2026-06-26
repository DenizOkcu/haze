import {describe, expect, it} from 'vitest';
import {finishMcpCustomResult, selectMcpActionResult, selectMcpPresetResult, selectMcpServerResult, setMcpServerKeyResult} from '../../src/cli/commands/mcpWizard.js';

const settings = {mcpServers: [{name: 'ctx', transport: 'http' as const, url: 'https://x'}]};

describe('mcp wizard helpers', () => {
  it('selects existing or missing servers', () => {
    expect(selectMcpServerResult(settings, 'ctx')).toMatchObject({mode: 'mcpAction', selectedName: 'ctx'});
    expect(selectMcpServerResult(settings, 'missing')).toMatchObject({mode: 'chat', message: expect.stringContaining('No MCP server')});
  });

  it('prepares presets', () => {
    expect(selectMcpPresetResult({}, 'context7')).toMatchObject({mode: 'mcpAddKey', draft: {name: 'context7', transport: 'http'}});
    expect(selectMcpPresetResult({mcpServers: [{name: 'context7', transport: 'http', url: 'https://x'}]}, 'context7')).toMatchObject({mode: 'chat', message: expect.stringContaining('already exists')});
  });

  it('toggles, removes, and sets keys', () => {
    expect(selectMcpActionResult(settings, 'ctx', 'disable').settingsPatch?.mcpServers?.[0].enabled).toBe(false);
    expect(selectMcpActionResult(settings, 'ctx', 'remove server')).toMatchObject({mode: 'mcpConfirmRemove'});
    expect(setMcpServerKeyResult(settings, 'ctx', 'secret').settingsPatch?.mcpServers?.[0].headers?.[0]).toEqual({name: 'Authorization', value: 'Bearer secret'});
  });

  it('builds valid custom servers', () => {
    expect(finishMcpCustomResult({}, {name: 'local', transport: 'stdio', command: 'node', args: ['x.js']}).server).toMatchObject({name: 'local', command: 'node'});
    expect(finishMcpCustomResult({}, {name: 'bad', transport: 'stdio'})).toMatchObject({mode: 'chat', message: 'Command is required for stdio transport.'});
  });
});
