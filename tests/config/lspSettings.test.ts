import {describe, expect, it} from 'vitest';
import {configuredLspServers, installedLspServers, lspPreset, removeLspServer, setLspServerEnabled, upsertLspServer} from '../../src/config/lspSettings.js';

describe('lspSettings', () => {
  it('normalizes configured servers', () => {
    const servers = configuredLspServers({lspServers: [{name: 'x', command: 'cmd', extensions: ['ts', '.tsx']} ]});
    expect(servers[0]).toMatchObject({name: 'x', command: 'cmd', extensions: ['.ts', '.tsx'], args: [], enabled: true});
  });

  it('upserts, toggles, and removes servers', () => {
    const settings = {lspServers: [{name: 'x', command: 'old'}]};
    const upserted = upsertLspServer(settings, {name: 'x', command: 'new', extensions: ['rs']});
    expect(upserted).toEqual([expect.objectContaining({name: 'x', command: 'new', extensions: ['.rs']})]);
    expect(setLspServerEnabled({lspServers: upserted}, 'x', false)[0]?.enabled).toBe(false);
    expect(removeLspServer({lspServers: upserted}, 'x')).toEqual([]);
  });

  it('returns preset copies', () => {
    const preset = lspPreset('typescript');
    expect(preset).toMatchObject({name: 'typescript', command: 'typescript-language-server'});
    preset!.extensions!.push('.mutated');
    expect(lspPreset('typescript')!.extensions).not.toContain('.mutated');
  });

  it('includes a php preset', () => {
    expect(lspPreset('php')).toMatchObject({name: 'php', command: 'intelephense', args: ['--stdio'], extensions: ['.php']});
  });

  it('filters servers whose command is not installed', async () => {
    await expect(installedLspServers({lspServers: [{name: 'missing', command: 'definitely-not-a-real-haze-lsp-command'}]})).resolves.toEqual([]);
  });
});
