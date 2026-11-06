/**
 * Code-graph data model: the persisted graph JSON shape, the in-memory index
 * built from it, and the workspace-keyed store layout contract shared by
 * extraction, build, and query.
 *
 * Nodes are files and the symbols they define; edges carry a relation and an
 * honest confidence label (`EXTRACTED` for relationships explicit in the
 * source, `INFERRED` for relationships resolved across files). The persisted
 * `schemaVersion` lets future extractors detect incompatible graphs, mirroring
 * the signature-validated sparse indexes used for exact readFile paging.
 */

export const GRAPH_SCHEMA_VERSION = 1;

export type GraphNodeKind = 'file' | 'function' | 'class' | 'method' | 'type' | 'field';

export type GraphEdgeRelation = 'defines' | 'imports' | 'calls' | 'inherits' | 'references';

/** How trustworthy an edge is; surfaces in tool output so the model can weigh it. */
export type GraphConfidence = 'EXTRACTED' | 'INFERRED';

export interface GraphNode {
  /** Deterministic id: the workspace-relative file path for files, `path#name` (plus `@line` on duplicates) for symbols. */
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** Workspace-relative source file. */
  file: string;
  /** 1-based definition line. */
  line: number;
  /** Community id assigned by label propagation; absent before analysis runs. */
  community?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: GraphEdgeRelation;
  confidence: GraphConfidence;
  /** Workspace-relative file where the relationship site lives (the import/call line, not the definition). */
  file?: string;
  /** 1-based line of the relationship site. */
  line?: number;
}

/** The persisted graph document written under `~/.haze/graphs/<workspace>/graph.json`. */
export interface CodeGraph {
  schemaVersion: number;
  extractorVersion: number;
  builtAt: string;
  fileCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Adjacency index over a {@link CodeGraph}; the query/analysis read surface. */
export interface GraphIndex {
  graph: CodeGraph;
  nodes: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  degree: Map<string, number>;
  /** Lowercased symbol label -> node ids (files excluded; symbol lookup only). */
  labels: Map<string, string[]>;
}

export function buildGraphIndex(graph: CodeGraph): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  const degree = new Map<string, number>();
  const labels = new Map<string, string[]>();
  for (const node of graph.nodes) {
    nodes.set(node.id, node);
    if (node.kind !== 'file') {
      const key = node.label.toLowerCase();
      const bucket = labels.get(key);
      if (bucket) bucket.push(node.id);
      else labels.set(key, [node.id]);
    }
  }
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    let outBucket = out.get(edge.source);
    if (!outBucket) {
      outBucket = [];
      out.set(edge.source, outBucket);
    }
    outBucket.push(edge);
    let inBucket = inn.get(edge.target);
    if (!inBucket) {
      inBucket = [];
      inn.set(edge.target, inBucket);
    }
    inBucket.push(edge);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return {graph, nodes, out, in: inn, degree, labels};
}

export function nodeDegree(index: GraphIndex, id: string): number {
  return index.degree.get(id) ?? 0;
}

/** Stable symbol-id construction; `path#name`, disambiguated by line on duplicates. */
export function symbolNodeId(file: string, name: string, line: number, taken: Set<string>): string {
  let id = `${file}#${name}`;
  if (!taken.has(id)) {
    taken.add(id);
    return id;
  }
  id = `${file}#${name}@${line}`;
  // Duplicate names at one line are pathological; keep appending until free.
  let suffix = 0;
  while (taken.has(id)) {
    suffix += 1;
    id = `${file}#${name}@${line}-${suffix}`;
  }
  taken.add(id);
  return id;
}

/** Parse and validate a graph document read from disk. Throws on unknown schema versions. */
export function parseCodeGraph(value: unknown): CodeGraph {
  if (typeof value !== 'object' || value == null) throw new Error('graph.json is not an object');
  const data = value as Record<string, unknown>;
  const schemaVersion = data.schemaVersion;
  if (typeof schemaVersion !== 'number' || schemaVersion > GRAPH_SCHEMA_VERSION) {
    throw new Error(`graph.json schema version ${String(schemaVersion)} is newer than supported ${GRAPH_SCHEMA_VERSION}; rebuild the graph`);
  }
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  const validNodes = nodes.filter((node): node is GraphNode =>
    typeof node === 'object' && node != null
    && typeof (node as GraphNode).id === 'string'
    && typeof (node as GraphNode).label === 'string'
    && typeof (node as GraphNode).file === 'string');
  const validEdges = edges.filter((edge): edge is GraphEdge =>
    typeof edge === 'object' && edge != null
    && typeof (edge as GraphEdge).source === 'string'
    && typeof (edge as GraphEdge).target === 'string');
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    extractorVersion: typeof data.extractorVersion === 'number' ? data.extractorVersion : 0,
    builtAt: typeof data.builtAt === 'string' ? data.builtAt : new Date(0).toISOString(),
    fileCount: typeof data.fileCount === 'number' ? data.fileCount : validNodes.filter(node => node.kind === 'file').length,
    nodes: validNodes,
    edges: validEdges,
  };
}
