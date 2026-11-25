import {tool, type ToolSet} from 'ai';
import {z} from 'zod';

const TOOL_GROUPS = ['git-read', 'git-write', 'git-network', 'graph', 'lsp'] as const;
export type ToolGroup = typeof TOOL_GROUPS[number];

// Membership is by exact tool name, never by prefix: an MCP server may expose
// `lspLint` or `graphQL`, and those are user-configured capabilities, not
// members of the built-in groups.
const GROUPED_TOOLS: Record<string, ToolGroup> = {
  gitStatus: 'git-read', gitLog: 'git-read', gitDiff: 'git-read', gitBranch: 'git-read',
  gitStage: 'git-write', gitCommit: 'git-write', gitBranchManage: 'git-write', gitRebase: 'git-write', gitReset: 'git-write',
  gitFetch: 'git-network', gitPull: 'git-network', gitClone: 'git-network',
  graphQuery: 'graph', graphExplain: 'graph', graphPath: 'graph', graphAffected: 'graph', graphRebuild: 'graph',
  lspWorkspaceSymbols: 'lsp', lspSymbols: 'lsp', lspFindSymbol: 'lsp', lspDefinition: 'lsp', lspTypeDefinition: 'lsp',
  lspImplementation: 'lsp', lspReferences: 'lsp', lspRenameSymbol: 'lsp', lspSafeDeleteSymbol: 'lsp', lspDiagnostics: 'lsp', lspDiagnosticsForSymbol: 'lsp',
};

export function toolGroup(name: string): ToolGroup | undefined {
  return Object.hasOwn(GROUPED_TOOLS, name) ? GROUPED_TOOLS[name] : undefined;
}

/** Semantic-navigation and orientation requests (shared by request seeding and tool selection). */
export const LSP_REQUEST_PATTERN = /\b(rename|refactor|move|symbols?|definitions?|references|usages?|impact|blast radius|navigate|navigation|semantic|callers?)\b/;
export const GRAPH_REQUEST_PATTERN = /\b(architecture|structure|how (?:does|do)|relationships?|dependenc\w*|affected|explore|understand|overview|graph|codebase|unfamiliar|orient\w*|large)\b/;

/** Seed groups for clear requests; ambiguous needs can use loadToolGroup. */
export function groupsForRequest(request: string): Set<ToolGroup> {
  const text = request.toLowerCase();
  const groups = new Set<ToolGroup>();
  if (/\b(git|repository status|repo status|working tree|staged|unstaged|commits?|branches|branch|diff|review (?:my |the )?changes|changed files)\b/.test(text)) groups.add('git-read');
  if (/\b(commit|stage|unstage|checkout|switch branch|create branch|delete branch|rename branch|rebase|reset)\b/.test(text)) groups.add('git-write');
  if (/\b(git\s+(?:fetch|pull|clone)|fetch (?:the |from )?(?:git|remote|repository|repo)|pull (?:the |from )?(?:git|remote|repository|repo|latest)|clone\b)/.test(text)) groups.add('git-network');
  if (GRAPH_REQUEST_PATTERN.test(text)) groups.add('graph');
  if (LSP_REQUEST_PATTERN.test(text)) groups.add('lsp');
  return groups;
}

export function toolsInLoadedGroups(tools: ToolSet, groups: ReadonlySet<ToolGroup>): ToolSet {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => {
    const group = toolGroup(name);
    return group != null && groups.has(group);
  }));
}

export function createToolGroupLoader(tools: ToolSet, groups: Set<ToolGroup>) {
  const available = TOOL_GROUPS.filter(group => Object.keys(toolsInLoadedGroups(tools, new Set([group]))).length > 0);
  return tool({
    description: `Load an optional tool group for the next step. Groups: git-read (status, log, diff, branch); git-write (stage, commit, branch changes, rebase, reset); git-network (fetch, pull, clone); graph (code relationships); lsp (semantic navigation, when configured). Available: ${available.join(', ')}. Loaded groups stay available for this goal. Shell remains available.`,
    inputSchema: z.object({group: z.enum(TOOL_GROUPS).describe('Tool group to load.')}),
    execute: async ({group}) => {
      const names = Object.keys(toolsInLoadedGroups(tools, new Set([group])));
      if (names.length === 0) return {ok: false, toolName: 'loadToolGroup', error: `Tool group ${group} is unavailable.`, recoverable: false, suggestedNextStep: group === 'lsp' ? 'Configure an installed language server with /lsp, or use grep and readFile.' : 'Use the available tools.'};
      const alreadyLoaded = groups.has(group);
      groups.add(group);
      return {ok: true, toolName: 'loadToolGroup', group, alreadyLoaded, tools: names, message: 'Tools are available on the next model step.'};
    },
  });
}
