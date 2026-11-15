import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ensureGraphInBackground, type GraphBuildResult} from '../../../src/core/graph/buildGraph.js';
import {writeGraph, type GraphStore} from '../../../src/core/graph/store.js';
import {GRAPH_SCHEMA_VERSION, type CodeGraph} from '../../../src/core/graph/model.js';
import {EXTRACTOR_VERSION} from '../../../src/core/graph/extract.js';

let tempDir: string;
let store: GraphStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-graph-bg-'));
  store = {dir: tempDir, graphPath: path.join(tempDir, 'graph.json'), manifestPath: path.join(tempDir, 'manifest.json'), cacheDir: path.join(tempDir, 'cache')};
});

afterEach(async () => {
  await fs.rm(tempDir, {recursive: true, force: true});
});

function sampleGraph(): CodeGraph {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    builtAt: new Date().toISOString(),
    fileCount: 1,
    nodes: [{id: 'src/a.ts', label: 'a.ts', kind: 'file', file: 'src/a.ts', line: 1}],
    edges: [],
  };
}

function fakeBuild(): GraphBuildResult {
  return {ok: true, store, graph: sampleGraph(), files: 1, skippedLarge: 0, parsedFiles: 1, cachedFiles: 0, durationMs: 1, incremental: false, capped: false};
}

describe('ensureGraphInBackground', () => {
  it('builds in the background when no graph exists yet', async () => {
    const build = vi.fn(async () => fakeBuild());
    const result = await ensureGraphInBackground({build});
    expect(build).toHaveBeenCalledTimes(1);
    expect(result?.ok).toBe(true);
  });

  it('incrementally rebuilds on every startup, even when a graph already exists', async () => {
    await writeGraph(store, sampleGraph(), {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: '/w', files: {'src/a.ts': {size: 5, mtimeMs: 1}}});
    const build = vi.fn(async () => fakeBuild());
    const result = await ensureGraphInBackground({build});
    expect(build).toHaveBeenCalledTimes(1);
    expect(result?.ok).toBe(true);
  });

  it('deduplicates concurrent calls and never rejects on build failure', async () => {
    const build = vi.fn(async () => fakeBuild());
    const first = ensureGraphInBackground({build});
    const second = ensureGraphInBackground({build});
    expect(second).toBe(first);
    await first;
    expect(build).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async (): Promise<GraphBuildResult> => { throw new Error('boom'); });
    await expect(ensureGraphInBackground({build: failing})).resolves.toBeUndefined();
  });

  it('reports activity while a build runs', async () => {
    const onActivity = vi.fn();
    await ensureGraphInBackground({build: async () => fakeBuild(), onActivity});
    expect(onActivity.mock.calls).toEqual([[true], [false]]);
  });
});
