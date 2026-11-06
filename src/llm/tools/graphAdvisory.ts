/**
 * Bounded graph advisory attached to successful file-mutation results, the
 * graph-side twin of the automatic LSP diagnostics hook: after editing a file,
 * the model immediately sees which symbols elsewhere depend on it (reverse
 * call/import edges with sites) without another tool call, plus a staleness
 * note for the touched file.
 *
 * Advisory only — it orients validation scope and follow-up edits; it never
 * counts as validation evidence and never blocks a mutation.
 */
import {workspaceRoot} from '../../utils/path.js';
import {buildGraphIndex} from '../../core/graph/model.js';
import {graphStoreFor, readGraph} from '../../core/graph/store.js';

const ADVISORY_FILE_LIMIT = 8;
const ADVISORY_PER_FILE = 5;
const ADVISORY_TOTAL = 12;

export interface GraphAffectedNeighbor {
  symbol: string;
  kind: string;
  /** e.g. `calls [INFERRED] at src/foo.ts:42` */
  via: string;
}

export interface PostMutationGraphResult {
  ok: boolean;
  stale: boolean;
  files: Array<{path: string; affectedNeighbors: GraphAffectedNeighbor[]}>;
  truncated: boolean;
}

export type PostMutationGraphAdvisory = (paths: readonly string[]) => Promise<PostMutationGraphResult | undefined>;

/**
 * Build the advisory hook. Self-disables (returns undefined) when no graph
 * exists yet — building one is an explicit model/user action, never a
 * side effect of a mutation.
 */
export function createPostMutationGraphAdvisory(): PostMutationGraphAdvisory {
  return async (paths: readonly string[]) => {
    const uniquePaths = [...new Set(paths)].slice(0, ADVISORY_FILE_LIMIT);
    if (uniquePaths.length === 0) return undefined;
    const store = graphStoreFor(workspaceRoot());
    let graph;
    try {
      graph = await readGraph(store);
    } catch {
      return undefined; // Unreadable graph: silent, the tools surface it on demand.
    }
    if (!graph) return undefined;
    const index = buildGraphIndex(graph);

    const files: PostMutationGraphResult['files'] = [];
    let remaining = ADVISORY_TOTAL;
    for (const filePath of uniquePaths) {
      if (remaining <= 0) break;
      const normalized = filePath.replace(/\\/g, '/');
      // Symbol nodes defined in the mutated file.
      const owned = graph.nodes.filter(node => node.kind !== 'file' && node.file === normalized);
      const neighbors: GraphAffectedNeighbor[] = [];
      const seen = new Set<string>();
      for (const symbol of owned) {
        for (const edge of index.in.get(symbol.id) ?? []) {
          if (edge.relation === 'defines') continue; // the file->symbol edge, not a dependency
          const source = index.nodes.get(edge.source);
          if (!source || source.file === normalized || seen.has(source.id)) continue;
          seen.add(source.id);
          neighbors.push({symbol: source.label, kind: source.kind, via: `${edge.relation} [${edge.confidence}] at ${edge.file ?? source.file}:${edge.line ?? '?'}`});
          remaining -= 1;
          if (neighbors.length >= ADVISORY_PER_FILE || remaining <= 0) break;
        }
        if (neighbors.length >= ADVISORY_PER_FILE || remaining <= 0) break;
      }
      files.push({path: normalized, affectedNeighbors: neighbors});
    }
    return {ok: true, stale: true, files, truncated: remaining <= 0 || uniquePaths.length < new Set(paths).size};
  };
}
