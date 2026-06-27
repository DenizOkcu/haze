import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {HazeSettings} from '../../src/config/settings.js';
import type {LoadedSkill} from '../../src/skills/types.js';

// Stub the disk-reading collaborators so the test exercises the assembly logic
// (tool wiring, category mapping, collision skipping) in isolation.
const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  loadSkillRegistry: vi.fn(),
  installedLspServers: vi.fn(),
  configuredMcpServers: vi.fn(),
  loadMcpTools: vi.fn(),
  modelWithConfig: vi.fn(),
}));

vi.mock('../../src/config/settings.js', async () => {
  const actual = await import('../../src/config/settings.js');
  return {...actual, readSettings: mocks.readSettings};
});
vi.mock('../../src/skills/SkillRegistry.js', () => ({loadSkillRegistry: mocks.loadSkillRegistry}));
vi.mock('../../src/config/lspSettings.js', () => ({installedLspServers: mocks.installedLspServers, configuredLspServers: mocks.configuredMcpServers}));
vi.mock('../../src/config/mcpSettings.js', () => ({configuredMcpServers: mocks.configuredMcpServers}));
vi.mock('../../src/llm/mcp.js', () => ({loadMcpTools: mocks.loadMcpTools}));
vi.mock('../../src/llm/client.js', () => ({modelWithConfig: mocks.modelWithConfig}));

const {assembleRequestContext} = await import('../../src/llm/requestContext.js');

const settings: HazeSettings = {provider: 'openrouter', model: 'gpt-4o', apiKey: 'k'};
const fakeModel = {modelId: 'gpt-4o'} as unknown as Parameters<typeof assembleRequestContext>[0]['model'];

function skill(name: string): LoadedSkill {
  return {dir: `/s/${name}`, path: `/s/${name}/SKILL.md`, name, description: 'd', body: 'b', references: [], source: 'global'};
}

describe('assembleRequestContext', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.modelWithConfig.mockResolvedValue(undefined);
  });

  it('registers built-in and subagent tools when no LSP/MCP/skills are configured', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);
    mocks.loadMcpTools.mockResolvedValue({tools: {}, clients: [], errors: []});

    const result = await assembleRequestContext({contextFiles: [], model: fakeModel});

    expect(result.availableTools.subagent).toBeDefined();
    expect(result.availableTools.readFile).toBeDefined();
    expect(result.toolCategories.get('subagent')).toBe('subagent');
    expect(result.toolCategories.get('readFile')).toBe('builtin');
    expect(result.toolCategories.get('skill')).toBeUndefined();
    expect(result.loadedMcp).toBeUndefined();
    expect(result.systemPrompt).toContain('Tools');
  });

  it('adds LSP and skill tools when available', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map([['alpha', skill('alpha')]])});
    mocks.installedLspServers.mockResolvedValue([{name: 'typescript', command: 'x', extensions: ['.ts']}]);
    mocks.configuredMcpServers.mockReturnValue([]);

    const result = await assembleRequestContext({contextFiles: [], model: fakeModel});

    expect(result.availableTools.skill).toBeDefined();
    expect(result.toolCategories.get('skill')).toBe('skill');
    // LSP tools are only added when a server is installed.
    expect(result.toolCategories.get('lspDefinition')).toBe('lsp');
  });

  it('loads and merges MCP tools, skipping name collisions', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([{name: 'ctx7', transport: 'http', url: 'u'}]);
    // MCP returns a tool that collides with a built-in name; it must be skipped.
    mocks.loadMcpTools.mockResolvedValue({
      tools: {readFile: {marker: 'mcp'}, weather: {marker: 'mcp'}},
      clients: [],
      errors: [],
    });

    const result = await assembleRequestContext({contextFiles: [], model: fakeModel});

    expect(mocks.loadMcpTools).toHaveBeenCalledWith([{name: 'ctx7', transport: 'http', url: 'u'}], expect.any(Set));
    expect(result.loadedMcp).toBeDefined();
    expect(result.availableTools.weather).toBeDefined();
    expect(result.toolCategories.get('weather')).toBe('mcp');
    // The built-in readFile must win over the colliding MCP tool.
    expect((result.availableTools.readFile as {marker?: string}).marker).toBeUndefined();
  });

  it('skips MCP servers that are explicitly disabled', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([{name: 'off', enabled: false, transport: 'http', url: 'u'}]);

    const result = await assembleRequestContext({contextFiles: [], model: fakeModel});

    expect(mocks.loadMcpTools).not.toHaveBeenCalled();
    expect(result.loadedMcp).toBeUndefined();
  });
});