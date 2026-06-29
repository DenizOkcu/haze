import {describe, expect, it, vi} from 'vitest';
import type {ContextFile} from '../../../src/config/contextFiles.js';
import type {HazeSettings} from '../../../src/config/settings.js';
import type {LoadedSkill} from '../../../src/skills/types.js';

// Only loadSkillRegistry touches the disk; stub it so the test is hermetic.
const mocks = vi.hoisted(() => ({
  loadSkillRegistry: vi.fn(),
}));
vi.mock('../../../src/skills/SkillRegistry.js', () => ({
  loadSkillRegistry: mocks.loadSkillRegistry,
}));

const {formatSettingsSummary} = await import('../../../src/cli/commands/settingsSummary.js');

function skills(...names: Array<string | [string, boolean]>) {
  const map = new Map<string, LoadedSkill>();
  for (const entry of names) {
    const [name] = Array.isArray(entry) ? entry : [entry];
    map.set(name, {
      dir: `/skills/${name}`,
      path: `/skills/${name}/SKILL.md`,
      name,
      description: 'test',
      body: 'body',
      references: [],
      source: 'global',
    });
  }
  return {skills: map};
}

const baseSettings: HazeSettings = {
  providers: [
    {name: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'secret', models: ['gpt-4o']},
    {name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']},
  ],
  provider: 'openrouter',
  model: 'gpt-4o',
  apiKey: 'secret',
  lspServers: [{name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts']}],
  mcpServers: [{name: 'context7', transport: 'http', url: 'https://ctx7.example/mcp'}],
};

describe('formatSettingsSummary', () => {
  it('reports provider, model, base url, and saved api key', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills('alpha'));
    const out = await formatSettingsSummary(baseSettings, []);
    expect(out).toContain('Provider: openrouter');
    expect(out).toContain('Model: gpt-4o');
    expect(out).toContain('Lightweight slot: not set (inherits primary)');
    expect(out).toContain('Fallback slot: not set (inherits primary)');
    expect(out).toContain('Base URL: https://openrouter.ai/api/v1');
    expect(out).toContain('API key: saved');
    expect(out).toContain('Configured providers: openrouter, local');
  });

  it('shows configured slots as provider:model and inherits primary when unset', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills());
    const settings: HazeSettings = {
      ...baseSettings,
      models: {lightweight: 'local:llama3.1', fallback: 'openrouter:gpt-4o'},
    };
    const out = await formatSettingsSummary(settings, []);
    expect(out).toContain('Lightweight slot: local:llama3.1');
    expect(out).toContain('Fallback slot: openrouter:gpt-4o');
  });

  it('falls back to not configured when no provider is set', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills());
    const out = await formatSettingsSummary({model: 'm'}, []);
    expect(out).toContain('Provider: not configured');
    expect(out).toContain('Model: not set');
    expect(out).toContain('Base URL: not configured');
    expect(out).toContain('API key: missing');
    expect(out).toContain('Configured providers: none');
  });

  it('uses models.primary when set for provider and model lines', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills());
    const settings: HazeSettings = {
      ...baseSettings,
      provider: 'openai',
      model: 'gpt-4o',
      models: {primary: 'local:llama3.1'},
    };
    const out = await formatSettingsSummary(settings, []);
    expect(out).toContain('Provider: local');
    expect(out).toContain('Model: llama3.1');
  });

  it('marks disabled skills and servers', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills(['alpha', true], ['beta', false]));
    const settings: HazeSettings = {
      ...baseSettings,
      skills: [{name: 'beta', enabled: false}],
      lspServers: [{name: 'typescript', enabled: false, command: 'x', extensions: ['.ts']}],
      mcpServers: [{name: 'context7', enabled: false, transport: 'http', url: 'u'}],
    };
    const out = await formatSettingsSummary(settings, []);
    expect(out).toContain('beta (disabled)');
    expect(out).toContain('typescript (disabled)');
    expect(out).toContain('context7 (disabled)');
  });

  it('lists context files with an aggregated token estimate', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills());
    const files: ContextFile[] = [
      {path: 'AGENTS.md', content: 'x'.repeat(40)},
      {path: 'CLAUDE.md', content: 'y'.repeat(80)},
    ];
    const out = await formatSettingsSummary(baseSettings, files);
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('CLAUDE.md');
    // 40/4 + 80/4 = 30 tokens
    expect(out).toContain('~30 tokens');
  });

  it('notes duplicate context files', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills());
    const files: ContextFile[] = [
      {path: 'a.md', content: 'same'},
      {path: 'b.md', content: 'same'},
    ];
    const out = await formatSettingsSummary(baseSettings, files);
    expect(out).toContain('Context note:');
    expect(out).toContain('duplicate group');
    expect(out).toContain('2 file');
  });

  it('shows none for empty lsp/mcp/skills lists', async () => {
    mocks.loadSkillRegistry.mockResolvedValue(skills());
    const out = await formatSettingsSummary({providers: [{name: 'p', url: 'u', models: ['m']}]}, []);
    expect(out).toContain('LSP servers: none');
    expect(out).toContain('MCP servers: none');
    expect(out).toContain('Skills: none');
  });
});