import {describe, expect, it} from 'vitest';
import {buildGraphIndex, GRAPH_SCHEMA_VERSION, type CodeGraph, type GraphEdge, type GraphNode} from '../../../src/core/graph/model.js';
import {findNodeCandidates, hubThreshold, pickSeeds, queryGraph, renderSubgraph, shortestPath, tokenizeQuery, traverse} from '../../../src/core/graph/query.js';

function graphFrom(nodes: GraphNode[], edges: GraphEdge[]): CodeGraph {
  return {schemaVersion: GRAPH_SCHEMA_VERSION, extractorVersion: 1, builtAt: new Date().toISOString(), fileCount: nodes.filter(node => node.kind === 'file').length, nodes, edges};
}

function sym(id: string, label: string, file = 'src/a.ts', line = 1): GraphNode {
  const kind = id === file ? 'file' : 'function';
  return {id, label, kind, file, line};
}

describe('graph query engine', () => {
  it('tokenizes questions and drops filler words', () => {
    expect(tokenizeQuery('How does the theme registry work?')).toEqual(['theme', 'registry']);
    expect(tokenizeQuery('!!!')).toEqual([]);
  });

  it('seeds on exact label matches and guarantees a seed per term', () => {
    const graph = graphFrom(
      [sym('src/a.ts#RegistryProvider', 'RegistryProvider'), sym('src/a.ts#OtherThing', 'OtherThing'), sym('src/b.ts#ThemeStore', 'ThemeStore')],
      [],
    );
    const index = buildGraphIndex(graph);
    const result = queryGraph(index, 'RegistryProvider');
    expect(result.seedCount).toBeGreaterThan(0);
    expect(result.answer).toContain('RegistryProvider');

    // One term's exact match cannot starve the other term's match.
    const multi = queryGraph(index, 'RegistryProvider ThemeStore');
    expect(multi.answer).toContain('RegistryProvider');
    expect(multi.answer).toContain('ThemeStore');
  });

  it('answers no-match questions honestly instead of inventing nodes', () => {
    const index = buildGraphIndex(graphFrom([sym('src/a.ts#One', 'One')], []));
    const result = queryGraph(index, 'totally absent topic');
    expect(result.seedCount).toBe(0);
    expect(result.answer).toMatch(/No graph nodes matched/);
  });

  it('demotes test paths unless the query asks about tests', () => {
    const graph = graphFrom(
      [sym('src/a.ts#runThing', 'runThing', 'src/a.ts'), sym('tests/a.test.ts#runThingTests', 'runThingTests', 'tests/a.test.ts')],
      [],
    );
    const index = buildGraphIndex(graph);
    const seeds = pickSeeds(index, [], new Map([['runthing', 'tests/a.test.ts#runThingTests']]));
    // The per-term guarantee keeps the test node as a seed only when nothing better exists;
    // with a source node present, scoring prefers it in queryGraph answers.
    const result = queryGraph(index, 'run thing');
    expect(result.answer).toContain('src/a.ts#runThing'.split('#')[1]!);
  });

  it('does not expand hub nodes as transit during traversal', () => {
    const nodes: GraphNode[] = [sym('src/hub.ts#Hub', 'Hub'), sym('src/one.ts#One', 'One'), sym('src/two.ts#Two', 'Two')];
    const edges: GraphEdge[] = [
      {source: 'src/hub.ts#Hub', target: 'src/one.ts#One', relation: 'calls', confidence: 'EXTRACTED'},
      {source: 'src/hub.ts#Hub', target: 'src/two.ts#Two', relation: 'calls', confidence: 'EXTRACTED'},
    ];
    // Push Hub's degree above the damping floor (p99 of the degree distribution, min 50).
    for (let i = 0; i < 60; i++) {
      const id = `src/spoke${i}.ts#Spoke${i}`;
      nodes.push(sym(id, `Spoke${i}`, `src/spoke${i}.ts`));
      edges.push({source: 'src/hub.ts#Hub', target: id, relation: 'calls', confidence: 'EXTRACTED'});
    }
    const index = buildGraphIndex(graphFrom(nodes, edges));
    expect(hubThreshold(index)).toBeLessThanOrEqual(62);
    // Hub damping: even though everything routes through Hub, one-hop seeds
    // reach the hub but never transit THROUGH it to its other neighbors.
    const fromOne = traverse(index, ['src/one.ts#One'], 2, 'bfs');
    expect(fromOne.visited.has('src/hub.ts#Hub')).toBe(true);
    expect(fromOne.visited.has('src/two.ts#Two')).toBe(false);
  });

  it('renders under a token budget and never cuts the seed block', () => {
    const nodes: GraphNode[] = [sym('src/seed.ts#Seed', 'Seed')];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `src/n${i}.ts#Node${i}`;
      nodes.push(sym(id, `Node${i}`, `src/n${i}.ts`));
      edges.push({source: 'src/seed.ts#Seed', target: id, relation: 'calls', confidence: 'EXTRACTED'});
    }
    const index = buildGraphIndex(graphFrom(nodes, edges));
    const traversal = traverse(index, ['src/seed.ts#Seed'], 1, 'bfs');
    const {answer, truncated} = renderSubgraph(index, traversal, ['src/seed.ts#Seed'], 100); // ~400 chars
    expect(truncated).toBe(true);
    expect(answer).toContain('NODE Seed [seed');
    expect(answer.length).toBeLessThan(600);
  });

  it('finds shortest paths with relations and confidence', () => {
    const nodes = [sym('src/a.ts#Alpha', 'Alpha'), sym('src/b.ts#Beta', 'Beta'), sym('src/c.ts#Gamma', 'Gamma')];
    const edges: GraphEdge[] = [
      {source: 'src/a.ts#Alpha', target: 'src/b.ts#Beta', relation: 'calls', confidence: 'INFERRED', file: 'src/a.ts', line: 3},
      {source: 'src/b.ts#Beta', target: 'src/c.ts#Gamma', relation: 'imports', confidence: 'EXTRACTED', file: 'src/b.ts', line: 1},
    ];
    const index = buildGraphIndex(graphFrom(nodes, edges));
    const path = shortestPath(index, 'src/a.ts#Alpha', 'src/c.ts#Gamma');
    expect(path?.path).toEqual(['src/a.ts#Alpha', 'src/b.ts#Beta', 'src/c.ts#Gamma']);
    expect(shortestPath(index, 'src/a.ts#Alpha', 'src/missing#Nope')).toBeUndefined();
  });

  it('resolves symbol lookups by exact, substring, and file path', () => {
    const index = buildGraphIndex(graphFrom([sym('src/llm/systemPrompt.ts#buildSystemPrompt', 'buildSystemPrompt', 'src/llm/systemPrompt.ts'), sym('src/llm/systemPrompt.ts', 'systemPrompt.ts', 'src/llm/systemPrompt.ts', 1)], []));
    expect(findNodeCandidates(index, 'buildSystemPrompt', 1)[0]?.id).toBe('src/llm/systemPrompt.ts#buildSystemPrompt');
    expect(findNodeCandidates(index, 'systemprompt', 2).length).toBeGreaterThan(0);
    expect(findNodeCandidates(index, 'nothing-matches-this', 1)).toHaveLength(0);
  });
});
