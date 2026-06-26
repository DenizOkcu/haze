import {describe, expect, it} from 'vitest';
import {finishLspCustomResult, selectLspActionResult, selectLspPresetResult, selectLspServerResult} from '../../src/cli/commands/lspWizard.js';

describe('lsp wizard helpers', () => {
  const settings = {lspServers: [{name: 'ts', command: 'typescript-language-server', args: ['--stdio'], enabled: true}]};

  it('selects existing or missing servers', () => {
    expect(selectLspServerResult(settings, 'ts')).toMatchObject({mode: 'lspAction', selectedName: 'ts'});
    expect(selectLspServerResult(settings, 'missing')).toMatchObject({mode: 'chat', message: expect.stringContaining('No LSP server')});
  });

  it('adds presets and detects duplicates', () => {
    expect(selectLspPresetResult({}, 'typescript').settingsPatch?.lspServers?.[0].name).toBe('typescript');
    expect(selectLspPresetResult({lspServers: [{name: 'typescript', command: 'x'}]}, 'typescript')).toMatchObject({mode: 'chat', message: expect.stringContaining('already exists')});
  });

  it('toggles and removes via actions', () => {
    expect(selectLspActionResult(settings, 'ts', 'disable').settingsPatch?.lspServers?.[0].enabled).toBe(false);
    expect(selectLspActionResult(settings, 'ts', 'remove server')).toMatchObject({mode: 'lspConfirmRemove'});
  });

  it('builds custom server settings from a command line', () => {
    const result = finishLspCustomResult({}, 'custom', 'cmd --stdio');
    expect(result.server).toMatchObject({name: 'custom', command: 'cmd', args: ['--stdio']});
  });
});
