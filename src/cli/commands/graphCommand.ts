/**
 * `/graph` — build or refresh the workspace code graph and print the
 * orientation report (subsystems, hub symbols, import cycles).
 *
 * `/graph status` only reports the current graph state without rebuilding.
 * `/graph force` rebuilds from scratch. `/graph delete` removes the persisted
 * graph for this workspace. Deterministic tree-sitter extraction; no LLM cost.
 */
import {buildGraphIndex} from '../../core/graph/model.js';
import {deleteGraph, graphStatus, graphStoreFor} from '../../core/graph/store.js';
import {buildWorkspaceGraph} from '../../core/graph/buildGraph.js';
import {renderGraphReport} from '../../core/graph/analyze.js';
import {workspaceRoot} from '../../utils/path.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleGraphCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const store = graphStoreFor(workspaceRoot());
  const arg = args.trim();
  if (arg === 'status') {
    const status = await graphStatus(store);
    if (!status.exists) {
      ctx.addSystemMessage('No code graph for this workspace yet. Run /graph to build one (deterministic, no LLM cost).');
      return 'handled';
    }
    const builtAt = status.builtAt ? new Date(status.builtAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
    ctx.addSystemMessage([
      `Code graph: ${status.nodeCount} nodes · ${status.edgeCount} edges · ${status.fileCount} files`,
      `Built at ${builtAt} (UTC)${status.stale ? ' · STALE: files changed since; run /graph to refresh' : ' · fresh'}`,
    ].join('\n'));
    return 'handled';
  }

  if (arg === 'delete') {
    const removed = await deleteGraph(store);
    ctx.addSystemMessage(removed
      ? 'Deleted the code graph for this workspace. Run /graph to rebuild it.'
      : 'No code graph for this workspace; nothing to delete.');
    return 'handled';
  }

  const force = arg === 'force';
  ctx.addSystemMessage(force ? 'Rebuilding the code graph from scratch…' : 'Building the code graph…');
  try {
    const result = await buildWorkspaceGraph({force});
    if (result.graph.nodes.length === 0) {
      ctx.addSystemMessage('No supported source files found (js/ts/tsx/jsx). Nothing to map.');
      return 'handled';
    }
    const report = renderGraphReport(buildGraphIndex(result.graph), {
      graph: result.graph,
      files: result.files,
      parsedFiles: result.parsedFiles,
      cachedFiles: result.cachedFiles,
      durationMs: result.durationMs,
      stale: false,
    });
    ctx.addSystemMessage(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.addSystemMessage(`Code graph build failed: ${message}`);
  }
  return 'handled';
}
