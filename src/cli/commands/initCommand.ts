import fs from 'node:fs/promises';
import {pathExists} from '../../utils/fs.js';
import path from 'node:path';
import {MAX_CONTEXT_FILE_CHARS} from '../../config/contextFiles.js';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import {buildWorkspaceGraph} from '../../core/graph/buildGraph.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleInitCommand(ctx: CommandContext): Promise<CommandResult> {
  await ctx.runAgentTurn(buildInitPrompt(), '/init');
  await ctx.refreshContextFiles();
  const agentsMdPath = path.join(process.cwd(), 'AGENTS.md');
  if (await pathExists(agentsMdPath)) {
    const content = await fs.readFile(agentsMdPath, 'utf8');
    const chars = content.length;
    const lines = content.split('\n').length;
    const msg = chars > MAX_CONTEXT_FILE_CHARS
      ? `AGENTS.md validation: ${chars.toLocaleString()} chars / ${lines} lines — exceeds the ${MAX_CONTEXT_FILE_CHARS.toLocaleString()}-char context budget and will be truncated. Trim it before relying on it.`
      : `AGENTS.md validation: ${chars.toLocaleString()} chars / ${lines} lines — within the ${MAX_CONTEXT_FILE_CHARS.toLocaleString()}-char context budget.`;
    ctx.addSystemMessage(msg);
  }
  // /init also builds/refreshes the workspace code graph so graph tools work
  // from the start; incremental, deterministic, no LLM cost. Failures never
  // block /init — the model can rebuild later via graphRebuild or /graph.
  try {
    const graph = await buildWorkspaceGraph();
    if (graph.graph.nodes.length > 0) {
      ctx.addSystemMessage(`Code graph: ${graph.graph.nodes.length} nodes · ${graph.graph.edges.length} edges · ${graph.files} files (${(graph.durationMs / 1000).toFixed(1)}s, ${graph.cachedFiles} cached / ${graph.parsedFiles} parsed).`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.addSystemMessage(`Code graph build skipped: ${message}`);
  }
  return 'handled';
}
