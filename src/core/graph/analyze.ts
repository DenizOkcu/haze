/**
 * Graph analysis: god nodes (degree hubs), import cycles (Tarjan SCC over
 * file-level import edges), communities (deterministic label propagation),
 * reverse blast radius, and the /map report renderer.
 *
 * Everything here is plain TS over the in-memory index — no dependencies, no
 * LLM, deterministic output (sorted iteration everywhere).
 */
import path from 'node:path';
import {buildGraphIndex, nodeDegree, type CodeGraph, type GraphIndex} from './model.js';

// ---------------------------------------------------------------------------
// Communities: label propagation over the undirected projection
// ---------------------------------------------------------------------------

const COMMUNITY_ITERATIONS = 8;

/**
 * Deterministic label propagation. Iteration order is node-id sorted and the
 * min-label rule breaks ties, so the same graph always yields the same
 * partition. Mutates `graph.nodes[].community` in place.
 */
export function detectCommunities(graph: CodeGraph): void {
  const index = buildGraphIndex(graph);
  const labels = new Map<string, string>();
  const ids = [...index.nodes.keys()].sort();
  for (const id of ids) labels.set(id, id);

  for (let iteration = 0; iteration < COMMUNITY_ITERATIONS; iteration++) {
    let changed = false;
    for (const id of ids) {
      const counts = new Map<string, number>();
      const bump = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
      bump(labels.get(id)!);
      for (const edge of index.out.get(id) ?? []) bump(labels.get(edge.target) ?? edge.target);
      for (const edge of index.in.get(id) ?? []) bump(labels.get(edge.source) ?? edge.source);
      let bestLabel = labels.get(id)!;
      let bestCount = -1;
      for (const [label, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
        if (count > bestCount) {
          bestLabel = label;
          bestCount = count;
        }
      }
      if (bestLabel !== labels.get(id)) {
        labels.set(id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Renumber communities by sorted representative for stable, readable ids.
  const communityIds = new Map<string, number>();
  for (const id of ids) {
    const label = labels.get(id)!;
    if (!communityIds.has(label)) communityIds.set(label, communityIds.size);
  }
  for (const node of graph.nodes) {
    const label = labels.get(node.id);
    if (label == null) continue;
    const community = communityIds.get(label);
    if (community != null) node.community = community;
  }
}

export interface CommunitySummary {
  community: number;
  size: number;
  /** Highest-degree members, files first: a one-line identity for the cluster. */
  members: Array<{id: string; label: string; kind: string; degree: number}>;
  /** Most common top-level directories among member files. */
  directories: string[];
}

export function communitySummaries(index: GraphIndex, limit = 12): CommunitySummary[] {
  const byCommunity = new Map<number, string[]>();
  for (const node of index.nodes.values()) {
    if (node.community == null) continue;
    const bucket = byCommunity.get(node.community) ?? [];
    bucket.push(node.id);
    byCommunity.set(node.community, bucket);
  }
  const summaries: CommunitySummary[] = [];
  for (const [community, ids] of byCommunity) {
    const ranked = ids
      .map(id => ({id, node: index.nodes.get(id)!, degree: nodeDegree(index, id)}))
      .filter(entry => entry.node != null)
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
    const members = [
      ...ranked.filter(entry => entry.node.kind === 'file').slice(0, 3),
      ...ranked.filter(entry => entry.node.kind !== 'file').slice(0, 4),
    ].map(entry => ({id: entry.id, label: entry.node.label, kind: entry.node.kind, degree: entry.degree}));
    const dirCounts = new Map<string, number>();
    for (const entry of ranked) {
      const segments = path.posix.dirname(entry.node.file).split('/');
      // 'src' alone says nothing in a monoglot repo; keep two segments there.
      const dir = segments[0] === 'src' || segments[0] === 'tests' ? segments.slice(0, 2).join('/') : segments[0] ?? '';
      if (dir && dir !== '.') dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const directories = [...dirCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([dir]) => dir);
    summaries.push({community, size: ids.length, members, directories});
  }
  return summaries.sort((a, b) => b.size - a.size || a.community - b.community).slice(0, limit);
}

// ---------------------------------------------------------------------------
// God nodes and import cycles
// ---------------------------------------------------------------------------

/** Test-path heuristic shared by god-node ranking and query demotion. */
export function isTestPath(file: string): boolean {
  const lowered = file.toLowerCase();
  return lowered.includes('.test.') || lowered.includes('.spec.') || lowered.includes('__tests__/') || /(^|\/)(tests?|fixtures?)\//.test(lowered);
}

export interface GodNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  degree: number;
}

/** Top-degree symbol nodes (files excluded; test helpers demoted — they mirror, not shape, the architecture). */
export function godNodes(index: GraphIndex, limit = 10): GodNode[] {
  const ranked: GodNode[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind === 'file') continue;
    if (isTestPath(node.file)) continue;
    ranked.push({id: node.id, label: node.label, kind: node.kind, file: node.file, degree: nodeDegree(index, node.id)});
  }
  return ranked.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Tarjan strongly-connected components over file-level `imports` edges. */
export function importCycles(index: GraphIndex, limit = 5): string[][] {
  const fileIds = [...index.nodes.values()].filter(node => node.kind === 'file').map(node => node.id).sort();
  const adjacency = new Map<string, string[]>();
  for (const id of fileIds) {
    const targets = (index.out.get(id) ?? [])
      .filter(edge => edge.relation === 'imports')
      .map(edge => edge.target);
    adjacency.set(id, targets);
  }

  let counter = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const cycles: string[][] = [];

  const strongConnect = (start: string) => {
    const work: Array<{node: string; next: number}> = [{node: start, next: 0}];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.next === 0) {
        indices.set(frame.node, counter);
        lowlinks.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      const neighbors = adjacency.get(frame.node) ?? [];
      let advanced = false;
      while (frame.next < neighbors.length) {
        const neighbor = neighbors[frame.next]!;
        frame.next += 1;
        if (!indices.has(neighbor)) {
          work.push({node: neighbor, next: 0});
          advanced = true;
          break;
        }
        if (onStack.has(neighbor)) {
          lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node)!, indices.get(neighbor)!));
        }
      }
      if (advanced) continue;
      if (lowlinks.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        while (true) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        if (component.length > 1) cycles.push(component.sort());
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowlinks.set(parent.node, Math.min(lowlinks.get(parent.node)!, lowlinks.get(frame.node)!));
    }
  };

  for (const id of fileIds) {
    if (!indices.has(id)) strongConnect(id);
  }
  return cycles.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

const AFFECTED_RELATIONS = new Set(['calls', 'inherits', 'references']);

export interface AffectedEntry {
  id: string;
  label: string;
  kind: string;
  file: string;
  depth: number;
  viaRelation: string;
  confidence: string;
  viaFile: string;
  viaLine?: number;
}

/**
 * Reverse blast radius from a symbol: who calls/inherits/imports it, transitively.
 * File-level `imports` edges are followed one hop (the file importing the
 * changed symbol's file) so consumers surface even when call sites are dynamic.
 */
export function affectedBySymbol(index: GraphIndex, symbolId: string, maxDepth = 3, limit = 40): AffectedEntry[] {
  const results = new Map<string, AffectedEntry>();
  const visited = new Set<string>([symbolId]);
  let frontier = [{id: symbolId, depth: 0}];

  while (frontier.length > 0 && results.size < limit) {
    const next: Array<{id: string; depth: number}> = [];
    for (const current of frontier) {
      for (const edge of index.in.get(current.id) ?? []) {
        if (visited.has(edge.source)) continue;
        if (!AFFECTED_RELATIONS.has(edge.relation) && !(edge.relation === 'imports' && current.depth === 0)) continue;
        visited.add(edge.source);
        const node = index.nodes.get(edge.source);
        if (!node) continue;
        if (node.kind !== 'file') {
          results.set(edge.source, {
            id: edge.source, label: node.label, kind: node.kind, file: node.file,
            depth: current.depth + 1, viaRelation: edge.relation, confidence: edge.confidence,
            viaFile: edge.file ?? node.file, ...(edge.line ? {viaLine: edge.line} : {}),
          });
        }
        next.push({id: edge.source, depth: current.depth + 1});
      }
    }
    frontier = next;
    if (frontier.some(entry => entry.depth >= maxDepth)) break;
  }
  return [...results.values()].sort((a, b) => a.depth - b.depth || b.viaRelation.localeCompare(a.viaRelation) || a.id.localeCompare(b.id)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// /map report
// ---------------------------------------------------------------------------

export interface MapReportInput {
  graph: CodeGraph;
  files: number;
  parsedFiles: number;
  cachedFiles: number;
  durationMs: number;
  stale: boolean;
}

/** Human-readable orientation report for /map: structure, hubs, risk areas. */
export function renderMapReport(index: GraphIndex, input: MapReportInput): string {
  const lines: string[] = [];
  const cacheHint = input.cachedFiles > 0 ? `, ${input.cachedFiles} cached / ${input.parsedFiles} parsed` : '';
  lines.push(`Code graph: ${input.graph.nodes.length} nodes · ${input.graph.edges.length} edges · ${input.files} source files (${(input.durationMs / 1000).toFixed(1)}s${cacheHint})`);
  if (input.stale) lines.push('Note: some files changed since this graph was built; run /map to refresh.');

  const communities = communitySummaries(index, 8);
  if (communities.length > 0) {
    lines.push('');
    lines.push('Subsystems (graph communities):');
    for (const community of communities) {
      const dirs = community.directories.length > 0 ? ` [${community.directories.join(', ')}]` : '';
      lines.push(`  ${community.community}: ${community.size} nodes${dirs}`);
      const memberLabels = community.members.slice(0, 4).map(member => member.kind === 'file' ? member.label : `${member.label} (${member.kind})`);
      lines.push(`     ${memberLabels.join(' · ')}`);
    }
  }

  const gods = godNodes(index, 8);
  if (gods.length > 0) {
    lines.push('');
    lines.push('Hub symbols (god nodes — change these carefully):');
    for (const god of gods) {
      lines.push(`  ${god.label} (${god.kind}, degree ${god.degree}) — ${god.file}`);
    }
  }

  const cycles = importCycles(index, 3);
  if (cycles.length > 0) {
    lines.push('');
    lines.push(`Import cycles: ${cycles.length} shown`);
    for (const cycle of cycles) {
      lines.push(`  ${cycle.join(' -> ')}`);
    }
  }
  return lines.join('\n');
}
