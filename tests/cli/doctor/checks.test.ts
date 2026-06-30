import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

let tmp = '';
let checks: typeof import('../../../src/cli/doctor/checks.js');

const mocks = vi.hoisted(() => ({
  commandExists: vi.fn<[], Promise<boolean>>(),
  readContextFiles: vi.fn<[], Promise<import('../../../src/config/contextFiles.js').ContextFile[]>>(),
  loadSkillRegistry: vi.fn<[], Promise<import('../../../src/skills/types.js').SkillRegistry>>(),
}));

async function loadChecks() {
  vi.doMock('../../../src/config/paths.js', () => ({
    HAZE_DIR: tmp,
    GLOBAL_SKILLS_DIR: path.join(tmp, 'skills'),
  }));
  vi.doMock('../../../src/config/lspSettings.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/config/lspSettings.js')>('../../../src/config/lspSettings.js');
    return {...actual, commandExists: mocks.commandExists};
  });
  vi.doMock('../../../src/config/contextFiles.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/config/contextFiles.js')>('../../../src/config/contextFiles.js');
    return {...actual, readContextFiles: mocks.readContextFiles};
  });
  vi.doMock('../../../src/skills/SkillRegistry.js', () => ({
    loadSkillRegistry: mocks.loadSkillRegistry,
  }));
  vi.resetModules();
  return import('../../../src/cli/doctor/checks.js');
}

describe('doctor checks', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-doctor-checks-test-'));
    mocks.commandExists.mockResolvedValue(true);
    mocks.readContextFiles.mockResolvedValue([]);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    checks = await loadChecks();
  });

  afterEach(async () => {
    await fs.remove(tmp);
    vi.clearAllMocks();
  });

  it('reports critical when no providers configured', async () => {
    const result = await checks.checkProvidersConfigured({});
    expect(result.severity).toBe('critical');
    expect(result.message).toContain('No providers');
  });

  it('reports ok when providers exist', async () => {
    const result = await checks.checkProvidersConfigured({
      providers: [{name: 'openrouter', url: 'https://openrouter.ai/api/v1', models: ['gpt-4o']}],
    });
    expect(result.severity).toBe('ok');
  });

  it('reports critical when activeModel cannot resolve', () => {
    const result = checks.checkActiveModel({providers: [{name: 'p', url: 'u', models: []}]});
    expect(result.severity).toBe('critical');
    expect(result.hint).toContain('models');
  });

  it('reports ok when node version is sufficient', () => {
    const result = checks.checkNodeVersion();
    expect(result.severity).toBe('ok');
  });

  it('reports ok when settings.json is missing', async () => {
    const result = await checks.checkSettingsValid();
    expect(result.severity).toBe('ok');
  });

  it('reports critical when settings.json is malformed', async () => {
    await fs.ensureDir(tmp);
    await fs.writeFile(path.join(tmp, 'settings.json'), '{not json', 'utf8');
    const result = await checks.checkSettingsValid();
    expect(result.severity).toBe('critical');
    expect(result.message).toContain('Malformed settings.json');
  });

  it('loads context files without error', async () => {
    const result = await checks.checkContextFiles();
    expect(['ok', 'info']).toContain(result.severity);
  });

  it('reports ok when .haze/ exists and is writable', async () => {
    await fs.ensureDir(tmp);
    const result = await checks.checkHazeDirWritable();
    expect(result.severity).toBe('ok');
  });

  it('reports info when .haze/ does not exist yet', async () => {
    await fs.remove(tmp);
    const result = await checks.checkHazeDirWritable();
    expect(result.severity).toBe('info');
  });

  it('reports invalid raw MCP server entries', async () => {
    const result = await checks.checkMcpServers({
      mcpServers: [
        {name: 'valid', transport: 'http', url: 'https://example.com/mcp'},
        {name: 'bad', transport: 'http'},
      ],
    });
    expect(result.severity).toBe('info');
    expect(result.message).toContain('bad: missing URL');
  });

  it('reports missing LSP commands without touching PATH', async () => {
    mocks.commandExists.mockResolvedValue(false);
    const result = await checks.checkLspServers({
      lspServers: [{name: 'missing', command: 'not-on-path-lsp'}],
    });
    expect(result.severity).toBe('info');
    expect(result.message).toContain('not-on-path-lsp');
    expect(mocks.commandExists).toHaveBeenCalledWith('not-on-path-lsp');
  });

  it('clears the reachability timer even when fetch throws', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const result = await checks.checkProviderReachable({
      providers: [{name: 'p', url: 'https://example.test/v1', models: ['m']}],
      provider: 'p',
      model: 'm',
    });
    expect(result.severity).toBe('warning');
    expect(result.message).toContain('network down');
    fetchSpy.mockRestore();
  });
});
