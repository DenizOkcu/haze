import type {ToolSet} from 'ai';
import {hazeTools} from './hazeTools.js';
import {lspTools} from './lspTools.js';
import {buildSystemPrompt, type PromptSession} from './systemPrompt.js';
import {readSettings} from '../config/settings.js';
import {installedLspServers} from '../config/lspSettings.js';
import {configuredMcpServers} from '../config/mcpSettings.js';
import {loadMcpTools, type LoadedMcpTools} from './mcp.js';
import {loadSkillRegistry} from '../skills/SkillRegistry.js';
import {buildSkillTools} from '../skills/skillTools.js';
import {isSkillEnabled} from '../config/skillSettings.js';
import {createSubagentTool} from '../core/subagent/subagentRunner.js';
import type {ContextFile} from '../config/contextFiles.js';

export type ToolCategory = 'builtin' | 'lsp' | 'skill' | 'subagent' | 'mcp';

/** Model type accepted by the subagent tool; derived so this module stays decoupled. */
export type RequestModel = Parameters<typeof createSubagentTool>[0]['model'];

export interface AssembledRequestContext {
  systemPrompt: string;
  availableTools: ToolSet;
  /** Tool name -> coarse origin bucket, used by /context to group token estimates. */
  toolCategories: Map<string, ToolCategory>;
  loadedMcp?: LoadedMcpTools;
}

/**
 * Assemble the system prompt and full tool set (built-in + LSP + subagent +
 * skills + MCP) for a model request. This is the single source of truth shared
 * by the agent turn (streaming.ts) and the /context command, so both observe
 * identical token breakdowns. Reads fresh settings from disk so MCP/LSP changes
 * since the last turn are reflected. MCP clients are returned for the caller to
 * close (`.close()`) once it is done with the assembled context.
 */
export async function assembleRequestContext(input: {
  contextFiles: ContextFile[];
  session?: PromptSession;
  model: RequestModel;
}): Promise<AssembledRequestContext> {
  const settings = await readSettings();
  const skillRegistry = await loadSkillRegistry();
  const enabledSkills = new Map([...skillRegistry.skills.entries()].filter(([name]) => isSkillEnabled(settings, name)));
  const hasInstalledLsp = (await installedLspServers(settings)).length > 0;

  const toolCategories = new Map<string, ToolCategory>();
  const availableTools: ToolSet = {};

  for (const [name, value] of Object.entries(hazeTools)) {
    toolCategories.set(name, 'builtin');
    availableTools[name] = value;
  }
  if (hasInstalledLsp) {
    for (const [name, value] of Object.entries(lspTools)) {
      toolCategories.set(name, 'lsp');
      availableTools[name] = value;
    }
  }
  const subagentTool = createSubagentTool({model: input.model, contextFiles: input.contextFiles, session: input.session});
  toolCategories.set('subagent', 'subagent');
  availableTools.subagent = subagentTool;
  const skillTools = buildSkillTools({skills: enabledSkills});
  for (const [name, value] of Object.entries(skillTools)) {
    toolCategories.set(name, 'skill');
    availableTools[name] = value;
  }

  const mcpServers = configuredMcpServers(settings).filter(server => server.enabled !== false);
  const loadedMcp = mcpServers.length > 0 ? await loadMcpTools(mcpServers, new Set(Object.keys(availableTools))) : undefined;
  if (loadedMcp && Object.keys(loadedMcp.tools).length > 0) {
    for (const [name, value] of Object.entries(loadedMcp.tools)) {
      toolCategories.set(name, 'mcp');
      availableTools[name] = value;
    }
  }

  const mcpAvailable = Boolean(loadedMcp && Object.keys(loadedMcp.tools).length > 0);
  const systemPrompt = buildSystemPrompt(input.contextFiles, input.session, {lspAvailable: hasInstalledLsp, mcpAvailable});

  return {systemPrompt, availableTools, toolCategories, loadedMcp};
}
