import {describe, expect, it} from 'vitest';
import {affectedBySymbol, communitySummaries, detectCommunities, godNodes, importCycles, isTestPath, renderMapReport} from '../../../src/core/graph/analyze.js';
import {buildGraphIndex, GRAPH_SCHEMA_VERSION, type CodeGraph, type GraphEdge, type GraphNode} from '../../../src/core/graph/model.js';

function graphFrom(nodes: GraphNode[], edges: GraphEdge[]): CodeGraph {
  return {schemaVersion: GRAPH_SCHEMA_VERSION, extractorVersion: 1, builtAt: new Date().toISOString(), fileCount: nodes.filter(node => node.kind === 'file').length, nodes, edges};
}

describe('graph analysis', () => {
  it('detects two communities deterministically', () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const cluster of ['a', 'b']) {
      for (let i = 0; i < 5; i++) {
        nodes.push({id: `src/${cluster}${i}.ts#Sym${cluster}${i}`, label: `Sym${cluster}${i}`, kind: 'function', file: `src/${cluster}${i}.ts`, line: 1});
      }
      for (let i = 0; i < 4; i++) {
        edges.push({source: `src/${cluster}${i}.ts#Sym${cluster}${i}`, target: `src/${cluster}${i + 1}.ts#Sym${cluster}${i + 1}`, relation: 'calls', confidence: 'EXTRACTED'});
      }
    }
    const graph = graphFrom(nodes, edges);
    detectCommunities(graph);
    const communities = new Set(nodes.map(node => node.community));
    expect(communities.size).toBe(2);
    // Deterministic: same graph, same partition.
    const before = nodes.map(node => node.community).join(',');
    detectCommunities(graph);
    expect(nodes.map(node => node.community).join(',')).toBe(before);
  });

  it('summarizes communities with directories and top members', () => {
    const nodes: GraphNode[] = [
      {id: 'src/core/one.ts#One', label: 'One', kind: 'function', file: 'src/core/one.ts', line: 1},
      {id: 'src/core/two.ts#Two', label: 'Two', kind: 'function', file: 'src/core/two.ts', line: 1},
      {id: 'src/ui/three.ts#Three', label: 'Three', kind: 'function', file: 'src/ui/three.ts', line: 1},
    ];
    const edges: GraphEdge[] = [
      {source: 'src/core/one.ts#One', target: 'src/core/two.ts#Two', relation: 'calls', confidence: 'EXTRACTED'},
    ];
    const graph = graphFrom(nodes, edges);
    detectCommunities(graph);
    const summaries = communitySummaries(buildGraphIndex(graph), 5);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some(summary => summary.directories.includes('src/core'))).toBe(true);
  });

  it('ranks god nodes excluding test files', () => {
    const nodes: GraphNode[] = [
      {id: 'src/hub.ts#Hub', label: 'Hub', kind: 'function', file: 'src/hub.ts', line: 1},
      {id: 'src/x.ts#X', label: 'X', kind: 'function', file: 'src/x.ts', line: 1},
      {id: 'tests/hub.test.ts#TestHub', label: 'TestHub', kind: 'function', file: 'tests/hub.test.ts', line: 1},
    ];
    const edges: GraphEdge[] = [
      {source: 'src/hub.ts#Hub', target: 'src/x.ts#X', relation: 'calls', confidence: 'EXTRACTED'},
      {source: 'tests/hub.test.ts#TestHub', target: 'src/hub.ts#Hub', relation: 'calls', confidence: 'EXTRACTED'},
      {source: 'tests/hub.test.ts#TestHub', target: 'src/x.ts#X', relation: 'calls', confidence: 'EXTRACTED'},
    ];
    const gods = godNodes(buildGraphIndex(graphFrom(nodes, edges)), 3);
    expect(gods.map(god => god.label)).toContain('Hub');
    expect(gods.map(god => god.label)).not.toContain('TestHub');
    expect(isTestPath('pkg/__tests__/a.ts')).toBe(true);
    expect(isTestPath('src/a.ts')).toBe(false);
  });

  it('finds import cycles through strongly connected components', () => {
    const nodes: GraphNode[] = [
      {id: 'src/a.ts', label: 'a.ts', kind: 'file', file: 'src/a.ts', line: 1},
      {id: 'src/b.ts', label: 'b.ts', kind: 'file', file: 'src/b.ts', line: 1},
      {id: 'src/c.ts', label: 'c.ts', kind: 'file', file: 'src/c.ts', line: 1},
    ];
    const edges: GraphEdge[] = [
      {source: 'src/a.ts', target: 'src/b.ts', relation: 'imports', confidence: 'EXTRACTED'},
      {source: 'src/b.ts', target: 'src/a.ts', relation: 'imports', confidence: 'EXTRACTED'},
      {source: 'src/b.ts', target: 'src/c.ts', relation: 'imports', confidence: 'EXTRACTED'},
    ];
    const cycles = importCycles(buildGraphIndex(graphFrom(nodes, edges)), 3);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('computes reverse blast radius with relation sites', () => {
    const nodes: GraphNode[] = [
      {id: 'src/core.ts#target', label: 'target', kind: 'function', file: 'src/core.ts', line: 5},
      {id: 'src/direct.ts#caller', label: 'caller', kind: 'function', file: 'src/direct.ts', line: 2},
      {id: 'src/indirect.ts#wrapper', label: 'wrapper', kind: 'function', file: 'src/indirect.ts', line: 3},
    ];
    const edges: GraphEdge[] = [
      {source: 'src/direct.ts#caller', target: 'src/core.ts#target', relation: 'calls', confidence: 'INFERRED', file: 'src/direct.ts', line: 4},
      {source: 'src/indirect.ts#wrapper', target: 'src/direct.ts#caller', relation: 'calls', confidence: 'EXTRACTED', file: 'src/indirect.ts', line: 6},
    ];
    const affected = affectedBySymbol(buildGraphIndex(graphFrom(nodes, edges)), 'src/core.ts#target', 3);
    expect(affected.map(entry => entry.label)).toEqual(['caller', 'wrapper']);
    expect(affected[0]).toMatchObject({depth: 1, viaRelation: 'calls', confidence: 'INFERRED', viaFile: 'src/direct.ts', viaLine: 4});
    expect(affected[1]?.depth).toBe(2);
  });

  it('renders a /map report with stats, hubs, and a staleness note', () => {
    const nodes: GraphNode[] = [
      {id: 'src/a.ts', label: 'a.ts', kind: 'file', file: 'src/a.ts', line: 1},
      {id: 'src/a.ts#One', label: 'One', kind: 'function', file: 'src/a.ts', line: 2},
    ];
    const graph = graphFrom(nodes, [{source: 'src/a.ts', target: 'src/a.ts#One', relation: 'defines', confidence: 'EXTRACTED'}]);
    const report = renderMapReport(buildGraphIndex(graph), {graph, files: 1, parsedFiles: 1, cachedFiles: 0, durationMs: 1200, stale: true});
    expect(report).toContain('2 nodes');
    expect(report).toContain('Hub symbols');
    expect(report).toContain('run /map to refresh');
  });
});
