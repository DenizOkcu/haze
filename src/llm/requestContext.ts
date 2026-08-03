import type {ToolSet} from 'ai';
import {hazeTools} from './hazeTools.js';
import {lspTools} from './lspTools.js';
import {buildSystemPrompt, type PromptSession} from './systemPrompt.js';
import {readSettings} from '../config/settings.js';
import {resolveWorkerRuntime, type ModelRuntimeSelection} from './client.js';
import {resolveExecutionProfile} from '../core/subagent/executionProfiles.js';
import {SubagentCoordinator, type CoordinatorEvent} from '../core/subagent/subagentCoordinator.js';
import {WorkspaceMutationPolicy} from '../core/subagent/workspaceMutationPolicy.js';
import {fallbackProviderCapabilities, fallbackWorkerRuntime, type WorkerRuntime} from '../core/subagent/contracts.js';
import {installedLspServers} from '../config/lspSettings.js';
import {configuredMcpServers} from '../config/mcpSettings.js';
import {loadMcpTools, type LoadedMcpTools} from './mcp.js';
import {loadSkillRegistry} from '../skills/SkillRegistry.js';
import {buildSkillTools} from '../skills/skillTools.js';
import {isSkillEnabled} from '../config/skillSettings.js';
import {createSubagentTool} from '../core/subagent/subagentRunner.js';
import type {ContextFile} from '../config/contextFiles.js';
import {addCapabilityTools} from './capabilities.js';

export type ToolCategory = 'builtin' | 'lsp' | 'skill' | 'subagent' | 'mcp';

/** Model type accepted by the subagent tool; derived so this module stays decoupled. */
export type RequestModel = NonNullable<Parameters<typeof createSubagentTool>[0]['model']>;

export interface SubagentOverrides {
  profile?: string;
  workerModel?: string;
  maxConcurrency?: number;
  forceMode?: 'inspect';
}

export interface TurnExecutionScope {
  coordinator: SubagentCoordinator;
  mutationPolicy: WorkspaceMutationPolicy;
}

export interface AssembledRequestContext {
  systemPrompt: string;
  availableTools: ToolSet;
  /** Tool name -> coarse origin bucket, used by /context to group token estimates. */
  toolCategories: Map<string, ToolCategory>;
  loadedMcp?: LoadedMcpTools;
  executionScope: TurnExecutionScope;
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
  modelRuntime?: ModelRuntimeSelection;
  subagentOverrides?: SubagentOverrides;
  onSubagentEvent?: (event: CoordinatorEvent) => void;
  abortSignal?: AbortSignal;
  executionScope?: TurnExecutionScope;
  /** Pre-read settings so a turn performs a single settings read (CR-024). */
  settings?: Awaited<ReturnType<typeof readSettings>>;
}): Promise<AssembledRequestContext> {
  const settings = input.settings ?? await readSettings();
  const skillRegistry = await loadSkillRegistry();
  const enabledSkills = new Map(skillRegistry.skills);
  if (skillRegistry.candidates) {
    enabledSkills.clear();
    for (const skill of skillRegistry.candidates) {
      if (isSkillEnabled(settings, skill.name, skill.source) && !enabledSkills.has(skill.name)) enabledSkills.set(skill.name, skill);
    }
  } else {
    for (const [name, skill] of enabledSkills) if (!isSkillEnabled(settings, name, skill.source)) enabledSkills.delete(name);
  }
  const hasInstalledLsp = (await installedLspServers(settings)).length > 0;
  const profileName = input.subagentOverrides?.profile ?? settings.subagents?.defaultProfile;
  const profile = resolveExecutionProfile(profileName, settings.subagents?.profiles, input.subagentOverrides?.maxConcurrency);
  const executionScope = input.executionScope ?? {
    mutationPolicy: new WorkspaceMutationPolicy(),
    coordinator: new SubagentCoordinator(profile ?? resolveExecutionProfile(undefined, undefined)!, input.onSubagentEvent),
  };
  const {coordinator, mutationPolicy} = executionScope;
  let blockedReason = profile ? undefined : `Unknown subagent profile ${profileName}. Configure subagents.profiles or select a built-in profile.`;
  let workerRuntime: WorkerRuntime | undefined;
  if (input.modelRuntime) {
    const resolution = await resolveWorkerRuntime({active: input.modelRuntime, settings, selector: input.subagentOverrides?.workerModel ?? settings.subagents?.workerModel, cwd: input.session?.cwd});
    if (resolution.status === 'found') workerRuntime = resolution.runtime;
    else blockedReason = resolution.message;
  } else if (settings.subagents?.workerModel || input.subagentOverrides?.workerModel) {
    blockedReason = 'An explicit worker model could not be resolved for this request. Configure it via /provider and retry.';
  }
  workerRuntime ??= {
    ...fallbackWorkerRuntime(input.model, input.modelRuntime?.selector, input.modelRuntime?.config.providerName),
    capabilities: input.modelRuntime?.config.capabilities ?? fallbackProviderCapabilities(),
  };

  const toolCategories = new Map<string, ToolCategory>();
  const availableTools: ToolSet = {};

  addCapabilityTools({availableTools, toolCategories, loaded: {category: 'builtin', tools: hazeTools}});
  if (hasInstalledLsp) addCapabilityTools({availableTools, toolCategories, loaded: {category: 'lsp', tools: lspTools}});
  addCapabilityTools({availableTools, toolCategories, loaded: {category: 'subagent', tools: {subagent: createSubagentTool({runtime: workerRuntime, profile: profile ?? undefined, coordinator, mutationPolicy, blockedReason, forceMode: input.subagentOverrides?.forceMode, session: input.session})}}});
  addCapabilityTools({availableTools, toolCategories, loaded: {category: 'skill', tools: buildSkillTools({skills: enabledSkills, errors: skillRegistry.errors ?? []})}});

  const mcpServers = configuredMcpServers(settings).filter(server => server.enabled !== false);
  const loadedMcp = mcpServers.length > 0
    ? await loadMcpTools(mcpServers, new Set(Object.keys(availableTools)), ...(input.abortSignal ? [input.abortSignal] : []))
    : undefined;
  if (loadedMcp && Object.keys(loadedMcp.tools).length > 0) {
    addCapabilityTools({availableTools, toolCategories, loaded: {category: 'mcp', tools: loadedMcp.tools}, skipCollisions: true});
  }

  const mcpAvailable = Boolean(loadedMcp && Object.keys(loadedMcp.tools).length > 0);
  const skillErrors = (skillRegistry.errors ?? []).map(error => `${error.source ? `${error.source}/` : ''}${error.directory}: ${error.message}`);
  const systemPrompt = `${buildSystemPrompt(input.contextFiles, input.session, {lspAvailable: hasInstalledLsp, mcpAvailable})}${skillErrors.length ? `\n\n<skill-load-errors>\nInvalid skills were isolated:\n${skillErrors.map(error => `- ${error}`).join('\n')}\n</skill-load-errors>` : ''}`;

  return {systemPrompt, availableTools, toolCategories, loadedMcp, executionScope};
}
