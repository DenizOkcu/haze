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
}));

vi.mock('../../src/config/settings.js', async () => {
  const actual = await import('../../src/config/settings.js');
  return {...actual, readSettings: mocks.readSettings};
});
vi.mock('../../src/skills/SkillRegistry.js', () => ({loadSkillRegistry: mocks.loadSkillRegistry}));
vi.mock('../../src/config/lspSettings.js', () => ({installedLspServers: mocks.installedLspServers, configuredLspServers: mocks.configuredMcpServers}));
vi.mock('../../src/config/mcpSettings.js', () => ({configuredMcpServers: mocks.configuredMcpServers}));
vi.mock('../../src/llm/mcp.js', () => ({loadMcpTools: mocks.loadMcpTools}));

const {assembleRequestContext} = await import('../../src/llm/requestContext.js');

const settings: HazeSettings = {provider: 'openrouter', model: 'gpt-4o', apiKey: 'k'};
const fakeModel = {modelId: 'gpt-4o'} as unknown as Parameters<typeof assembleRequestContext>[0]['model'];

function skill(name: string): LoadedSkill {
  return {dir: `/s/${name}`, path: `/s/${name}/SKILL.md`, name, description: 'd', body: 'b', references: [], source: 'global'};
}

describe('assembleRequestContext', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('keeps a simple coding request on the lean built-in tool set', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);
    mocks.loadMcpTools.mockResolvedValue({tools: {}, clients: [], errors: []});

    const result = await assembleRequestContext({request: 'Implement the small CLI.', contextFiles: [], model: fakeModel});

    expect(result.availableTools.subagent).toBeUndefined();
    expect(result.availableTools.fetch).toBeUndefined();
    expect(result.availableTools.process).toBeUndefined();
    expect(result.availableTools.writeTasks).toBeDefined();
    expect(result.availableTools.readFile).toBeDefined();
    expect(result.toolCategories.get('subagent')).toBeUndefined();
    expect(result.toolCategories.get('readFile')).toBe('builtin');
    expect(result.toolCategories.get('skill')).toBeUndefined();
    expect(result.loadedMcp).toBeUndefined();
    expect(result.executionScope.coordinator).toBeDefined();
    expect(result.executionScope.mutationPolicy).toBeDefined();
    expect(result.systemPrompt).toContain('Tool use');
    expect(result.systemPrompt).not.toContain('Use subagent');
    expect(result.systemPrompt).not.toContain('fetch reads');
  });

  it('enables optional tools only when the request calls for them', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);

    const result = await assembleRequestContext({request: 'Use parallel agents to research online docs, run a dev server in the background, and maintain a task list.', contextFiles: [], model: fakeModel});

    expect(result.availableTools).toMatchObject({subagent: expect.anything(), fetch: expect.anything(), process: expect.anything(), writeTasks: expect.anything()});
    expect(result.systemPrompt).toContain('Use subagent');
    expect(result.systemPrompt).toContain('fetch reads');
  });

  it('reuses a supplied turn execution scope across request retries', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);
    const first = await assembleRequestContext({contextFiles: [], model: fakeModel});
    const retry = await assembleRequestContext({contextFiles: [], model: fakeModel, executionScope: first.executionScope});
    expect(retry.executionScope).toBe(first.executionScope);
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