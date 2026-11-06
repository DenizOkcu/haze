/**
 * The code-graph tool set (`graphQuery`, `graphExplain`, `graphPath`,
 * `graphAffected`, `graphRebuild`) over the persistent workspace symbol graph
 * built by `core/graph`.
 *
 * The graph is a deterministic AST-derived map of the codebase: querying it
 * is cheap and bounded, edges carry EXTRACTED/INFERRED confidence, and every
 * result annotates staleness so the model knows when the map lags the working
 * tree. Graph output is orientation and retrieval — never validation
 * evidence.
 */
import {tool} from 'ai';
import {z} from 'zod';
import {workspaceRoot} from '../../utils/path.js';
import {buildGraphIndex, type GraphEdge, type GraphIndex} from '../../core/graph/model.js';
import {graphStatus, graphStoreFor} from '../../core/graph/store.js';
import {findNodeCandidates, queryGraph, renderPath, shortestPath} from '../../core/graph/query.js';
import {affectedBySymbol} from '../../core/graph/analyze.js';
import {buildWorkspaceGraph} from '../../core/graph/buildGraph.js';

type GraphLoad =
  | {ok: true; index: GraphIndex; stale: boolean}
  | {ok: false; error: string; reasonCode: 'graph_not_built' | 'graph_unavailable'; suggestedNextStep: string};

/** Load the stored graph and index it, with a signature-based staleness check. */
async function loadGraphIndex(): Promise<GraphLoad> {
  const store = graphStoreFor(workspaceRoot());
  try {
    const status = await graphStatus(store);
    if (!status.exists) {
      return {
        ok: false,
        reasonCode: 'graph_not_built',
        error: 'No code graph for this workspace yet.',
        suggestedNextStep: 'Call graphRebuild first (deterministic tree-sitter extraction, no LLM cost, incremental on later runs), or ask the user to run /map.',
      };
    }
    if (!status.graph) throw new Error('graph.json disappeared between reads');
    return {ok: true, index: buildGraphIndex(status.graph), stale: status.stale};
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'graph_unavailable',
      error: error instanceof Error ? error.message : String(error),
      suggestedNextStep: 'The stored code graph is unreadable. Call graphRebuild to recreate it.',
    };
  }
}

/** Attach graph stats + staleness to a tool result; a stale map must announce itself. */
function graphMeta(loaded: {index: GraphIndex; stale: boolean}) {
  return {graph: {nodes: loaded.index.graph.nodes.length, edges: loaded.index.graph.edges.length, builtAt: loaded.index.graph.builtAt, stale: loaded.stale}};
}

function candidateList(index: GraphIndex, query: string): string | undefined {
  const candidates = findNodeCandidates(index, query, 4);
  if (candidates.length === 0) return undefined;
  return candidates.map(node => `${node.label} (${node.kind} ${node.file}:${node.line})`).join('\n');
}

function graphNotBuilt(toolName: string, loaded: Extract<GraphLoad, {ok: false}>) {
  return {ok: false, toolName, error: loaded.error, reasonCode: loaded.reasonCode, recoverable: true, suggestedNextStep: loaded.suggestedNextStep};
}

export const graphTools = {
  graphQuery: tool({
    description: 'Query the persistent workspace code graph with a natural-language question (architecture, relationships, "where does X live", "what surrounds Y"). Returns a token-budgeted subgraph; prefer this over grep loops for orientation on large codebases. Edges carry EXTRACTED/INFERRED confidence. Read-only.',
    inputSchema: z.object({
      question: z.string().min(1).describe('Question or topic, e.g. "how is context compacted" or "theme registry"'),
      mode: z.enum(['bfs', 'dfs']).default('bfs').describe('bfs explores broadly around matches; dfs follows one chain deeply'),
      depth: z.number().int().min(1).max(4).default(2).describe('Traversal hops from matched nodes'),
      budgetTokens: z.number().int().min(200).max(4000).default(1500).describe('Answer token budget'),
    }),
    execute: async ({question, mode, depth, budgetTokens}) => {
      const loaded = await loadGraphIndex();
      if (!loaded.ok) return graphNotBuilt('graphQuery', loaded);
      try {
        const result = queryGraph(loaded.index, question, {mode, depth, budgetTokens});
        if (result.seedCount === 0) {
          return {ok: true, toolName: 'graphQuery', question, answer: result.answer, hint: 'No graph nodes matched. Try different terms, grep for the exact string, or graphRebuild if the codebase changed.', ...graphMeta(loaded)};
        }
        return {ok: true, toolName: 'graphQuery', question, mode, answer: result.answer, truncated: result.truncated, seeds: result.seedCount, nodes: result.nodeCount, edges: result.edgeCount, ...graphMeta(loaded)};
      } catch (error) {
        return {ok: false, toolName: 'graphQuery', error: error instanceof Error ? error.message : String(error), recoverable: true, suggestedNextStep: 'Retry with a simpler question, or rebuild the graph with graphRebuild.'};
      }
    },
  }),

  graphExplain: tool({
    description: 'Explain one symbol or file from the code graph: definition site, community, degree, and its neighbors grouped by relation (calls, imports, inherits). Read-only.',
    inputSchema: z.object({
      symbol: z.string().min(1).describe('Symbol name or file path'),
    }),
    execute: async ({symbol}) => {
      const loaded = await loadGraphIndex();
      if (!loaded.ok) return graphNotBuilt('graphExplain', loaded);
      const candidates = findNodeCandidates(loaded.index, symbol, 1);
      if (candidates.length === 0) {
        return {ok: true, toolName: 'graphExplain', symbol, error: `No graph node matches "${symbol}".`, hint: 'Try grep for discovery, or graphRebuild if the codebase changed.', ...graphMeta(loaded)};
      }
      const node = candidates[0]!;
      const index = loaded.index;
      const describe = (edges: GraphEdge[], direction: 'out' | 'in') => edges.map(edge => {
        const other = index.nodes.get(direction === 'out' ? edge.target : edge.source);
        const at = edge.line ? ` (${edge.file}:${edge.line})` : '';
        return other ? `${edge.relation} [${edge.confidence}] ${other.label} (${other.kind} ${other.file}:${other.line})${at}` : undefined;
      }).filter((line): line is string => line != null);
      return {
        ok: true,
        toolName: 'graphExplain',
        symbol,
        node: {label: node.label, kind: node.kind, file: node.file, line: node.line, ...(node.community != null ? {community: node.community} : {})},
        degree: (index.out.get(node.id)?.length ?? 0) + (index.in.get(node.id)?.length ?? 0),
        outgoing: describe((index.out.get(node.id) ?? []).slice(0, 12), 'out'),
        incoming: describe((index.in.get(node.id) ?? []).slice(0, 12), 'in'),
        ...graphMeta(loaded),
      };
    },
  }),

  graphPath: tool({
    description: 'Trace the shortest relationship path between two symbols/files in the code graph, hop by hop with relations and confidence. Answers "how does a request get from A to B". Read-only.',
    inputSchema: z.object({
      from: z.string().min(1).describe('Starting symbol name or file path'),
      to: z.string().min(1).describe('Target symbol name or file path'),
    }),
    execute: async ({from, to}) => {
      const loaded = await loadGraphIndex();
      if (!loaded.ok) return graphNotBuilt('graphPath', loaded);
      const fromNode = findNodeCandidates(loaded.index, from, 1)[0];
      const toNode = findNodeCandidates(loaded.index, to, 1)[0];
      if (!fromNode || !toNode) {
        return {ok: true, toolName: 'graphPath', from, to, error: `No graph node matches ${!fromNode ? `"${from}"` : ''}${!fromNode && !toNode ? ' or ' : ''}${!toNode ? `"${to}"` : ''}.`, hint: !fromNode ? candidateList(loaded.index, from) : candidateList(loaded.index, to), ...graphMeta(loaded)};
      }
      const path = shortestPath(loaded.index, fromNode.id, toNode.id);
      if (!path) {
        return {ok: true, toolName: 'graphPath', from, to, error: `No path found between ${fromNode.label} and ${toNode.label} within 8 hops.`, ...graphMeta(loaded)};
      }
      return {ok: true, toolName: 'graphPath', from: fromNode.label, to: toNode.label, hops: path.edges.length, answer: renderPath(loaded.index, path), ...graphMeta(loaded)};
    },
  }),

  graphAffected: tool({
    description: 'Reverse blast radius of a symbol: who calls/inherits/imports it, transitively, with relation sites. Use before risky edits and to choose which files/tests a change should cover. Advisory context only — never validation evidence. Read-only.',
    inputSchema: z.object({
      symbol: z.string().min(1).describe('Symbol name or file path'),
      maxDepth: z.number().int().min(1).max(5).default(3).describe('How many call/import hops to follow back'),
    }),
    execute: async ({symbol, maxDepth}) => {
      const loaded = await loadGraphIndex();
      if (!loaded.ok) return graphNotBuilt('graphAffected', loaded);
      const candidates = findNodeCandidates(loaded.index, symbol, 1);
      if (candidates.length === 0) {
        return {ok: true, toolName: 'graphAffected', symbol, error: `No graph node matches "${symbol}".`, hint: candidateList(loaded.index, symbol), ...graphMeta(loaded)};
      }
      const affected = affectedBySymbol(loaded.index, candidates[0]!.id, maxDepth);
      return {
        ok: true,
        toolName: 'graphAffected',
        symbol,
        affected: affected.map(entry => ({
          depth: entry.depth, kind: entry.kind, label: entry.label, file: entry.file,
          via: `${entry.viaRelation} [${entry.confidence}] at ${entry.viaFile}:${entry.viaLine ?? '?'}`,
        })),
        ...(affected.length === 0 ? {hint: 'No reverse relationships recorded. Dynamic dispatch and untyped call sites are invisible to the graph; treat this as a floor, not a ceiling.'} : {}),
        ...graphMeta(loaded),
      };
    },
  }),

  graphRebuild: tool({
    description: 'Build or incrementally refresh the workspace code graph (deterministic tree-sitter extraction, no LLM cost; incremental rebuilds only re-parse changed files). Needed once before graphQuery/graphExplain/graphPath/graphAffected work, and after large refactors.',
    inputSchema: z.object({
      force: z.boolean().default(false).describe('Force a full rebuild even when the graph looks healthy (e.g. after mass file deletion)'),
    }),
    execute: async ({force}) => {
      try {
        const result = await buildWorkspaceGraph({force});
        if (result.graph.nodes.length === 0) {
          return {ok: true, toolName: 'graphRebuild', files: 0, nodes: 0, edges: 0, note: 'No supported source files found (js/ts/tsx/jsx only for now). Nothing to map.'};
        }
        return {
          ok: true,
          toolName: 'graphRebuild',
          files: result.files,
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
          parsedFiles: result.parsedFiles,
          cachedFiles: result.cachedFiles,
          durationMs: result.durationMs,
          ...(result.skippedLarge > 0 ? {skippedLarge: result.skippedLarge} : {}),
          ...(result.capped ? {capped: true, note: `Capped at the file limit; the graph covers the first ${result.files} files.`} : {}),
        };
      } catch (error) {
        return {ok: false, toolName: 'graphRebuild', error: error instanceof Error ? error.message : String(error), recoverable: true, suggestedNextStep: 'Retry, or report the error if it persists; graph unavailability never blocks other tools.'};
      }
    },
  }),
};
