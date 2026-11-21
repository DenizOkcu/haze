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

  it('loads Git groups for clear requests and keeps unrelated schemas deferred', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);
    const plain = await assembleRequestContext({request: 'Fix the parser.', contextFiles: [], model: fakeModel});
    expect(plain.availableTools.loadToolGroup).toBeDefined();
    expect(plain.availableTools.gitStatus).toBeUndefined();
    expect(plain.availableTools.gitClone).toBeUndefined();
    const review = await assembleRequestContext({request: 'Review my changes', contextFiles: [], model: fakeModel});
    expect(review.availableTools.gitStatus).toBeDefined();
    expect(review.availableTools.gitDiff).toBeDefined();
    expect(review.availableTools.gitCommit).toBeUndefined();
    expect(review.availableTools.gitClone).toBeUndefined();
    expect(review.systemPrompt).not.toContain('gitCommit');
    const commit = await assembleRequestContext({request: 'Commit the changes', contextFiles: [], model: fakeModel});
    expect(commit.availableTools.gitCommit).toBeDefined();
    expect(commit.availableTools.gitStatus).toBeDefined();
    const clone = await assembleRequestContext({request: 'Clone the remote repository', contextFiles: [], model: fakeModel});
    expect(clone.availableTools.gitClone).toBeDefined();
    expect(clone.availableTools.gitCommit).toBeUndefined();
  });

  it('loads deferred groups on request and preserves them across retries', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);
    const first = await assembleRequestContext({request: 'Investigate the problem', contextFiles: [], model: fakeModel});
    const loader = first.availableTools.loadToolGroup as {execute: (input: {group: string}, context: object) => Promise<Record<string, unknown>>};
    expect(await loader.execute({group: 'git-read'}, {})).toMatchObject({ok: true, group: 'git-read', tools: expect.arrayContaining(['gitStatus'])});
    expect(first.availableTools.gitStatus).toBeUndefined(); // exposed at the next step, not the current batch
    expect(await loader.execute({group: 'lsp'}, {})).toMatchObject({ok: false});
    const retry = await assembleRequestContext({request: 'Investigate the problem', contextFiles: [], model: fakeModel, executionScope: first.executionScope});
    expect(retry.availableTools.gitStatus).toBeDefined();
    expect(retry.availableTools.gitCommit).toBeUndefined();
    expect(retry.executionScope).toBe(first.executionScope);
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

  it('gates LSP and graph tool groups on request intent', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([{name: 'typescript', command: 'x', extensions: ['.ts']}]);
    mocks.configuredMcpServers.mockReturnValue([]);

    const plain = await assembleRequestContext({request: 'Fix the off-by-one in the parser.', contextFiles: [], model: fakeModel});
    expect(plain.availableTools.lspDefinition).toBeUndefined();
    expect(plain.availableTools.graphQuery).toBeUndefined();
    expect(plain.toolCategories.get('lspDefinition')).toBeUndefined();
    expect(plain.systemPrompt).not.toContain('lspWorkspaceSymbols');
    expect(plain.systemPrompt).not.toContain('primary navigation surface');

    const semantic = await assembleRequestContext({request: 'Rename this function across all references and show the architecture of the module.', contextFiles: [], model: fakeModel});
    expect(semantic.availableTools.lspDefinition).toBeDefined();
    expect(semantic.availableTools.graphQuery).toBeDefined();
    expect(semantic.toolCategories.get('lspDefinition')).toBe('lsp');
    expect(semantic.systemPrompt).toContain('lspWorkspaceSymbols');
    expect(semantic.systemPrompt).toContain('primary navigation surface');
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

  it('clamps native fleet concurrency to the deployment allowance', async () => {
    mocks.readSettings.mockResolvedValue(settings);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.configuredMcpServers.mockReturnValue([]);
    const runtime = (activeSequences?: number) => ({selector: {provider: 'haze.build', model: 'haze1.5-builder-flash'}, config: {providerKind: 'haze-build', providerName: 'haze.build', modelName: 'haze1.5-builder-flash', reasoningPolicy: {effective: 'disabled'}, capabilities: {}, ...(activeSequences != null ? {deployment: {activeSequences}} : {})}}) as unknown as Parameters<typeof assembleRequestContext>[0]['modelRuntime'];
    const fleetCap = async (activeSequences?: number) => {
      const assembled = await assembleRequestContext({contextFiles: [], model: fakeModel, modelRuntime: runtime(activeSequences)});
      const profile = (assembled.executionScope.coordinator as unknown as {profile: {maxConcurrency: number}}).profile;
      return profile.maxConcurrency;
    };
    // The manifest is authoritative: raise it and the fleet follows.
    expect(await fleetCap(3)).toBe(3);
    expect(await fleetCap(1)).toBe(1);
    // Deployments that advertise nothing stay conservative at two workers so
    // a future multi-tenant server only ever needs to lower the value.
    expect(await fleetCap()).toBe(2);
  });
});