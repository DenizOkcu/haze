import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeStaleness, graphStoreFor, pruneExtractionCache, readCachedExtraction, readGraph, readManifest, workspaceGraphKey, writeCachedExtraction, writeGraph, type GraphStore} from '../../../src/core/graph/store.js';
import {parseCodeGraph, GRAPH_SCHEMA_VERSION, type CodeGraph} from '../../../src/core/graph/model.js';
import {EXTRACTOR_VERSION, type FileExtraction} from '../../../src/core/graph/extract.js';

let tempDir: string;
let store: GraphStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-graph-store-'));
  store = {dir: tempDir, graphPath: path.join(tempDir, 'graph.json'), manifestPath: path.join(tempDir, 'manifest.json'), cacheDir: path.join(tempDir, 'cache')};
});

afterEach(async () => {
  await fs.rm(tempDir, {recursive: true, force: true});
});

function sampleGraph(nodeCount = 600): CodeGraph {
  const nodes = Array.from({length: nodeCount}, (_, index) => ({
    id: index === 0 ? 'src/a.ts' : `src/a.ts#sym${index}`,
    label: index === 0 ? 'a.ts' : `sym${index}`,
    kind: (index === 0 ? 'file' : 'function') as 'file' | 'function',
    file: 'src/a.ts',
    line: index + 1,
  }));
  return {schemaVersion: GRAPH_SCHEMA_VERSION, extractorVersion: EXTRACTOR_VERSION, builtAt: new Date().toISOString(), fileCount: 1, nodes, edges: []};
}

describe('graph store', () => {
  it('keys workspace graphs by hashed real path', () => {
    const key = workspaceGraphKey('/some/workspace');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(graphStoreFor('/some/workspace').dir.endsWith(key)).toBe(true);
  });

  it('round-trips graph and manifest through disk', async () => {
    const graph = sampleGraph(10);
    await writeGraph(store, graph, {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: '/w', files: {'src/a.ts': {size: 5, mtimeMs: 1}}});
    const restored = await readGraph(store);
    expect(restored?.nodes).toHaveLength(10);
    expect(parseCodeGraph(JSON.parse(await fs.readFile(store.graphPath, 'utf8'))).schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    const manifest = await readManifest(store);
    expect(manifest?.files['src/a.ts']).toEqual({size: 5, mtimeMs: 1});
  });

  it('refuses a near-empty overwrite of a healthy graph unless forced', async () => {
    await writeGraph(store, sampleGraph(600), {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: '/w', files: {}});
    await expect(writeGraph(store, sampleGraph(10), {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: '/w', files: {}})).rejects.toThrow(/Refusing to shrink/);
    await expect(writeGraph(store, sampleGraph(10), {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: '/w', files: {}}, {force: true})).resolves.toBeUndefined();
    expect((await readGraph(store))?.nodes).toHaveLength(10);
  });

  it('reports staleness from manifest signatures', async () => {
    await writeGraph(store, sampleGraph(10), {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: '/w', files: {'src/a.ts': {size: 5, mtimeMs: 1}, 'src/gone.ts': {size: 1, mtimeMs: 1}}});
    const fresh = await computeStaleness(store, {'src/a.ts': {size: 5, mtimeMs: 1}});
    expect(fresh.stale).toBe(true); // src/gone.ts removed
    expect(fresh.files.removed).toEqual(['src/gone.ts']);
    const changed = await computeStaleness(store, {'src/a.ts': {size: 9, mtimeMs: 1}, 'src/gone.ts': {size: 1, mtimeMs: 1}});
    expect(changed.files.changed).toEqual(['src/a.ts']);
    const added = await computeStaleness(store, {'src/a.ts': {size: 5, mtimeMs: 1}, 'src/gone.ts': {size: 1, mtimeMs: 1}, 'src/new.ts': {size: 2, mtimeMs: 3}});
    expect(added.files.added).toEqual(['src/new.ts']);
  });

  it('caches extractions by content hash and invalidates on extractor version', async () => {
    const extraction: FileExtraction = {version: EXTRACTOR_VERSION, file: 'src/a.ts', symbols: [], imports: [], calls: [], heritage: [], exports: []};
    await writeCachedExtraction(store, 'abc123', extraction);
    expect((await readCachedExtraction(store, 'abc123'))?.file).toBe('src/a.ts');
    const staleVersion: FileExtraction = {...extraction, version: EXTRACTOR_VERSION + 1};
    await writeCachedExtraction(store, 'def456', staleVersion);
    expect(await readCachedExtraction(store, 'def456')).toBeUndefined();
    expect(await readCachedExtraction(store, 'missing')).toBeUndefined();
  });

  it('prunes the extraction cache to a bounded count', async () => {
    for (let index = 0; index < 12; index++) {
      await writeCachedExtraction(store, `hash${index}`, {version: EXTRACTOR_VERSION, file: `src/f${index}.ts`, symbols: [], imports: [], calls: [], heritage: [], exports: []});
    }
    await pruneExtractionCache(store, 5);
    const remaining = (await fs.readdir(store.cacheDir)).length;
    expect(remaining).toBe(5);
  });
});
