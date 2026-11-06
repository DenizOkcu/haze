/**
 * Graph query engine: natural-language-ish retrieval over the code graph,
 * following the design that made graphify's retrieval outperform grep/read
 * loops on large repos —
 *
 *  - IDF-weighted exact/prefix/substring scoring over symbol labels and file
 *    paths, with coverage scaling so one incidental exact match cannot drown
 *    out multi-term matches;
 *  - one guaranteed seed per distinct query term (a collision on one term
 *    cannot starve the others);
 *  - hub-damped BFS/DFS (nodes above ~p99 degree are never expanded as
 *    transit; seeds are exempt) so framework hubs don't flood the answer;
 *  - token-budgeted rendering that cuts at line boundaries and never cuts the
 *    seed block, file-first so answers read like a map.
 *
 * Haze's 4-chars-per-token heuristic sets the char budget from a token budget.
 */
import {nodeDegree, type GraphEdge, type GraphIndex, type GraphNode} from './model.js';
import {isTestPath} from './analyze.js';

const QUERY_STOPWORDS = new Set([
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'does', 'did', 'is', 'are', 'was', 'were',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have', 'had',
  'the', 'and', 'but', 'not', 'for', 'from', 'with', 'into', 'that', 'this', 'these', 'those',
  'work', 'works', 'working', 'get', 'gets', 'call', 'calls', 'called', 'use', 'uses', 'used', 'using',
  'me', 'my', 'it', 'its',
]);

const EXACT_TIER = 1000;
const PREFIX_TIER = 100;
const SUBSTRING_TIER = 1;
const PATH_TIER = 0.5;

export function tokenizeQuery(question: string): string[] {
  const tokens = question.toLowerCase().split(/[^a-z0-9_$]+/).filter(token => token.length > 1);
  const content = tokens.filter(token => !QUERY_STOPWORDS.has(token));
  return [...new Set(content.length > 0 ? content : tokens)];
}

/** Document frequency per token over lowercased labels + file paths, for IDF weighting. */
function computeIdf(index: GraphIndex, tokens: string[]): Map<string, number> {
  const total = index.nodes.size || 1;
  const idf = new Map<string, number>();
  for (const token of tokens) {
    let df = 0;
    for (const node of index.nodes.values()) {
      const haystack = `${node.label.toLowerCase()} ${node.file.toLowerCase()}`;
      if (haystack.includes(token)) df += 1;
    }
    idf.set(token, Math.log(1 + total / (1 + df)));
  }
  return idf;
}

interface ScoredNode {
  id: string;
  score: number;
  /** Query tokens matched by this node's label (coverage numerator). */
  matched: number;
}

function scoreNodes(index: GraphIndex, tokens: string[], idf: Map<string, number>): {ranked: ScoredNode[]; bestByTerm: Map<string, string>} {
  const ranked: ScoredNode[] = [];
  const bestByTerm = new Map<string, {score: number; degree: number; id: string}>();
  for (const node of index.nodes.values()) {
    const label = node.label.toLowerCase();
    const filePath = node.file.toLowerCase();
    let score = 0;
    let matched = 0;
    let tiered = 0;
    for (const token of tokens) {
      const weight = idf.get(token) ?? 1;
      const substringHit = label.includes(token);
      const pathHit = filePath.includes(token);
      let tier = 0;
      if (token === label) {
        tier = EXACT_TIER * weight;
        matched += 1;
      } else if (label.startsWith(token)) {
        tier = PREFIX_TIER * weight;
        matched += 1;
      } else if (substringHit) {
        score += SUBSTRING_TIER * weight;
        matched += 1;
      }
      if (pathHit) score += PATH_TIER * weight;
      tiered += tier;
      // Track the best node per term for the per-term seed guarantee. Ties
      // prefer the higher-degree node (the more load-bearing definition).
      const singleton = tier > 0 || substringHit || pathHit ? (tier > 0 ? tier : SUBSTRING_TIER * weight) : 0;
      if (singleton > 0) {
        const degree = nodeDegree(index, node.id);
        const current = bestByTerm.get(token);
        if (!current || singleton > current.score || (singleton === current.score && degree > current.degree)) {
          bestByTerm.set(token, {score: singleton, degree, id: node.id});
        }
      }
    }
    // Coverage scaling: a lone exact hit on one of many terms must not beat
    // nodes matching several terms (squared because exact is 10x prefix).
    if (tiered > 0 && tokens.length > 0) {
      score += tiered * (matched / tokens.length) ** 2;
    }
    // Test helpers repeat the question's words in their own names; demote them
    // unless the question itself asks about tests.
    if (score > 0 && isTestPath(node.file) && !tokens.some(token => token === 'test' || token === 'tests' || token === 'testing' || token === 'spec')) {
      score *= 0.3;
    }
    if (score > 0) ranked.push({id: node.id, score, matched});
  }
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {ranked, bestByTerm: new Map([...bestByTerm].map(([token, value]) => [token, value.id]))};
}

/** Pick BFS seeds: top-scoring with a score-gap cutoff, then guarantee one seed per query term. */
export function pickSeeds(index: GraphIndex, ranked: ScoredNode[], bestByTerm: Map<string, string>, maxSeeds = 4, gapRatio = 0.15): string[] {
  if (ranked.length === 0) return [];
  const seeds: string[] = [];
  const seen = new Set<string>();
  const top = ranked[0]!.score;
  for (const entry of ranked) {
    if (seeds.length >= maxSeeds) break;
    if (seeds.length > 0 && entry.score < top * gapRatio) break;
    const labelKey = index.nodes.get(entry.id)?.label.toLowerCase() ?? entry.id;
    if (seen.has(labelKey)) continue;
    seen.add(labelKey);
    seeds.push(entry.id);
  }
  // Per-term guarantee: an incidental exact match on one term cannot starve matches on the others.
  for (const id of bestByTerm.values()) {
    const node = index.nodes.get(id);
    if (!node || seeds.includes(id)) continue;
    const labelKey = node.label.toLowerCase();
    if (seen.has(labelKey)) continue;
    seen.add(labelKey);
    seeds.push(id);
    if (seeds.length >= maxSeeds + 4) break;
  }
  return seeds;
}

/** p99-degree threshold, floored at 50: nodes at/above it are transit-opaque hubs. */
export function hubThreshold(index: GraphIndex): number {
  if (index.nodes.size === 0) return 50;
  const degrees: number[] = [];
  for (const id of index.nodes.keys()) degrees.push(nodeDegree(index, id));
  degrees.sort((a, b) => a - b);
  const p99 = degrees[Math.floor(degrees.length * 0.99)] ?? 50;
  return Math.max(50, p99);
}

export interface TraversalResult {
  visited: Set<string>;
  edges: Array<{source: string; target: string}>;
}

/** Hub-damped BFS/DFS over both edge directions; records induced edges among visited nodes. */
export function traverse(index: GraphIndex, seeds: string[], depth: number, mode: 'bfs' | 'dfs' = 'bfs'): TraversalResult {
  const seedSet = new Set(seeds);
  const visited = new Set<string>(seeds);
  const edgesSeen: Array<{source: string; target: string}> = [];
  const edgeKey = new Set<string>();
  const threshold = hubThreshold(index);

  const neighborsOf = (id: string): string[] => {
    const result: string[] = [];
    for (const edge of index.out.get(id) ?? []) result.push(edge.target);
    for (const edge of index.in.get(id) ?? []) result.push(edge.source);
    return result;
  };
  const record = (from: string, to: string) => {
    const key = `${from}\u0000${to}`;
    if (!edgeKey.has(key)) {
      edgeKey.add(key);
      edgesSeen.push({source: from, target: to});
    }
  };

  if (mode === 'bfs') {
    let frontier = [...seeds];
    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const current of frontier) {
        if (!seedSet.has(current) && nodeDegree(index, current) >= threshold) continue;
        for (const neighbor of neighborsOf(current)) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          record(current, neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
  } else {
    const stack: Array<{id: string; depth: number}> = seeds.map(id => ({id, depth: 0}));
    while (stack.length > 0) {
      const {id, depth: currentDepth} = stack.pop()!;
      if (visited.has(id) && !seedSet.has(id)) continue;
      if (currentDepth > depth) continue;
      visited.add(id);
      if (!seedSet.has(id) && nodeDegree(index, id) >= threshold) continue;
      for (const neighbor of neighborsOf(id)) {
        if (!visited.has(neighbor)) {
          record(id, neighbor);
          stack.push({id: neighbor, depth: currentDepth + 1});
        }
      }
    }
  }

  // Complete induced edges among visited nodes (traversals only record discovery edges).
  for (const id of [...visited].sort()) {
    for (const edge of index.out.get(id) ?? []) {
      if (edge.target !== id && visited.has(edge.target)) record(id, edge.target);
    }
  }
  return {visited, edges: edgesSeen};
}

export interface QueryResult {
  answer: string;
  truncated: boolean;
  seedCount: number;
  nodeCount: number;
  edgeCount: number;
}

const DEFAULT_TOKEN_BUDGET = 1500;
const MAX_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

function edgeLine(index: GraphIndex, source: string, target: string): string | undefined {
  const sourceNode = index.nodes.get(source);
  const targetNode = index.nodes.get(target);
  if (!sourceNode || !targetNode) return undefined;
  const first = index.out.get(source)?.find(edge => edge.target === target)
    ?? index.in.get(source)?.find(edge => edge.source === target);
  if (!first) return undefined;
  const at = first.line ? ` at ${first.file}:${first.line}` : '';
  return `EDGE ${sourceNode.label} --${first.relation} [${first.confidence}]--> ${targetNode.label}${at}`;
}

function nodeLine(index: GraphIndex, id: string, seed: boolean): string {
  const node = index.nodes.get(id)!;
  const community = node.community != null ? ` community=${node.community}` : '';
  return `NODE ${node.label} [${seed ? 'seed ' : ''}${node.kind} src=${node.file}:${node.line}${community}]`;
}

/** Render the traversed subgraph under a token budget; the seed block is never cut. */
export function renderSubgraph(index: GraphIndex, traversal: TraversalResult, seeds: string[], budgetTokens = DEFAULT_TOKEN_BUDGET): {answer: string; truncated: boolean} {
  const charBudget = Math.min(budgetTokens, MAX_TOKEN_BUDGET) * CHARS_PER_TOKEN;
  const seedSet = new Set(seeds);
  const dist = new Map<string, number>(seeds.map(id => [id, 0]));
  // Hop distance from seeds over both directions, for budget-cut ordering:
  // the nodes that answer the question survive the cut, hubs don't push them out.
  let frontier = [...seeds];
  let hop = 0;
  while (frontier.length > 0) {
    hop += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of index.out.get(id) ?? []) {
        if (!dist.has(edge.target) && traversal.visited.has(edge.target)) {
          dist.set(edge.target, hop);
          next.push(edge.target);
        }
      }
      for (const edge of index.in.get(id) ?? []) {
        if (!dist.has(edge.source) && traversal.visited.has(edge.source)) {
          dist.set(edge.source, hop);
          next.push(edge.source);
        }
      }
    }
    frontier = next;
  }

  const orderedNodes = [...seeds, ...[...traversal.visited]
    .filter(id => !seedSet.has(id))
    .sort((a, b) => (dist.get(a) ?? 99) - (dist.get(b) ?? 99) || nodeDegree(index, b) - nodeDegree(index, a) || a.localeCompare(b))];

  const lines: string[] = [];
  for (const id of orderedNodes) {
    if (index.nodes.has(id)) lines.push(nodeLine(index, id, seedSet.has(id)));
  }
  for (const edge of traversal.edges) {
    const line = edgeLine(index, edge.source, edge.target);
    if (line) lines.push(line);
  }

  let output = lines.join('\n');
  if (output.length <= charBudget) return {answer: output, truncated: false};
  const cutCandidate = output.slice(0, charBudget);
  let cutAt = cutCandidate.lastIndexOf('\n');
  if (cutAt <= 0) cutAt = charBudget;
  // Never cut the seed block: extend the cut to cover it (seeds are bounded).
  const seedBlockEnd = lines.slice(0, seeds.length).reduce((sum, line) => sum + line.length + 1, 0) - 1;
  cutAt = Math.max(cutAt, Math.min(seedBlockEnd, output.length));
  output = `${output.slice(0, cutAt)}\n[… truncated; raise budget or query more specifically]`;
  return {answer: output, truncated: true};
}

/** Full question-to-subgraph pipeline. */
export function queryGraph(index: GraphIndex, question: string, options: {mode?: 'bfs' | 'dfs'; depth?: number; budgetTokens?: number} = {}): QueryResult {
  const tokens = tokenizeQuery(question);
  if (tokens.length === 0) {
    return {answer: 'No searchable terms in the question.', truncated: false, seedCount: 0, nodeCount: 0, edgeCount: 0};
  }
  const idf = computeIdf(index, tokens);
  const {ranked, bestByTerm} = scoreNodes(index, tokens, idf);
  if (ranked.length === 0) {
    return {answer: `No graph nodes matched: ${tokens.join(', ')}.`, truncated: false, seedCount: 0, nodeCount: 0, edgeCount: 0};
  }
  const seeds = pickSeeds(index, ranked, bestByTerm);
  const traversal = traverse(index, seeds, options.depth ?? 2, options.mode ?? 'bfs');
  const {answer, truncated} = renderSubgraph(index, traversal, seeds, options.budgetTokens);
  return {answer, truncated, seedCount: seeds.length, nodeCount: traversal.visited.size, edgeCount: traversal.edges.length};
}

/** Symbol lookup for explain/path/affected: exact label, then label substring, then path substring. */
export function findNodeCandidates(index: GraphIndex, query: string, limit = 5): GraphNode[] {
  const lowered = query.toLowerCase();
  const exact = index.labels.get(lowered) ?? [];
  const scored: Array<{node: GraphNode; score: number}> = [];
  for (const id of exact) {
    const node = index.nodes.get(id);
    if (node) scored.push({node, score: 1000 + nodeDegree(index, id)});
  }
  if (scored.length === 0) {
    for (const node of index.nodes.values()) {
      if (node.kind === 'file') continue;
      const label = node.label.toLowerCase();
      if (label === lowered) scored.push({node, score: 1000 + nodeDegree(index, node.id)});
      else if (label.includes(lowered)) scored.push({node, score: 100 + nodeDegree(index, node.id)});
    }
  }
  if (scored.length === 0) {
    for (const node of index.nodes.values()) {
      if (node.file.toLowerCase().includes(lowered)) scored.push({node, score: 50 + nodeDegree(index, node.id)});
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit).map(entry => entry.node);
}

/** Shortest path between two nodes over the undirected projection; BFS with parent tracking. */
export function shortestPath(index: GraphIndex, from: string, to: string, maxDepth = 8): {path: string[]; edges: GraphEdge[]} | undefined {
  if (from === to) return {path: [from], edges: []};
  const parent = new Map<string, {node: string; edge: GraphEdge}>();
  const visited = new Set<string>([from]);
  let frontier = [from];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    depth += 1;
    const next: string[] = [];
    for (const current of frontier) {
      const steps: Array<{neighbor: string; edge: GraphEdge}> = [];
      for (const edge of index.out.get(current) ?? []) steps.push({neighbor: edge.target, edge});
      for (const edge of index.in.get(current) ?? []) steps.push({neighbor: edge.source, edge});
      for (const step of steps) {
        if (visited.has(step.neighbor)) continue;
        visited.add(step.neighbor);
        parent.set(step.neighbor, {node: current, edge: step.edge});
        if (step.neighbor === to) {
          const path = [to];
          const edges: GraphEdge[] = [];
          let cursor = to;
          while (cursor !== from) {
            const link = parent.get(cursor)!;
            edges.unshift(link.edge);
            cursor = link.node;
            path.unshift(cursor);
          }
          return {path, edges};
        }
        next.push(step.neighbor);
      }
    }
    frontier = next;
  }
  return undefined;
}

/** Render a path result: one line per hop with relation and confidence. */
export function renderPath(index: GraphIndex, result: {path: string[]; edges: GraphEdge[]}): string {
  const lines: string[] = [];
  for (const [position, edge] of result.edges.entries()) {
    const fromNode = index.nodes.get(result.path[position]);
    const toNode = index.nodes.get(result.path[position + 1]);
    if (!fromNode || !toNode) continue;
    const at = edge.line ? ` at ${edge.file}:${edge.line}` : '';
    lines.push(`${fromNode.label} (${fromNode.kind} ${fromNode.file}) --${edge.relation} [${edge.confidence}]--> ${toNode.label}${at}`);
  }
  return lines.length > 0 ? lines.join('\n') : `${index.nodes.get(result.path[0])?.label ?? result.path[0]} (same node)`;
}
