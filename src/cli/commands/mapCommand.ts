/**
 * `/map` — build or refresh the workspace code graph and print the
 * orientation report (subsystems, hub symbols, import cycles).
 *
 * `/map status` only reports the current graph state without rebuilding.
 * Deterministic tree-sitter extraction; no LLM cost.
 */
import {buildGraphIndex} from '../../core/graph/model.js';
import {graphStatus, graphStoreFor} from '../../core/graph/store.js';
import {buildWorkspaceGraph} from '../../core/graph/buildGraph.js';
import {renderMapReport} from '../../core/graph/analyze.js';
import {workspaceRoot} from '../../utils/path.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleMapCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const store = graphStoreFor(workspaceRoot());
  if (args.trim() === 'status') {
    const status = await graphStatus(store);
    if (!status.exists) {
      ctx.addSystemMessage('No code graph for this workspace yet. Run /map to build one (deterministic, no LLM cost).');
      return 'handled';
    }
    const builtAt = status.builtAt ? new Date(status.builtAt).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
    ctx.addSystemMessage([
      `Code graph: ${status.nodeCount} nodes · ${status.edgeCount} edges · ${status.fileCount} files`,
      `Built at ${builtAt} (UTC)${status.stale ? ' · STALE: files changed since; run /map to refresh' : ' · fresh'}`,
    ].join('\n'));
    return 'handled';
  }

  const force = args.trim() === 'force';
  ctx.addSystemMessage(force ? 'Rebuilding the code graph from scratch…' : 'Building the code graph…');
  try {
    const result = await buildWorkspaceGraph({force});
    if (result.graph.nodes.length === 0) {
      ctx.addSystemMessage('No supported source files found (js/ts/tsx/jsx). Nothing to map.');
      return 'handled';
    }
    const report = renderMapReport(buildGraphIndex(result.graph), {
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
