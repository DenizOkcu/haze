/**
 * Per-workspace graph persistence under `~/.haze/graphs/<workspace-key>/`:
 * `graph.json` (the graph document), `manifest.json` (file signatures), and
 * `cache/` (content-hash extraction cache).
 *
 * Storage lives in the home directory like sessions, so the user's repository
 * is never polluted and gitignore semantics never apply to haze's own
 * artifacts. All writes are atomic (temp file + rename).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseCodeGraph, type CodeGraph} from './model.js';
import {EXTRACTOR_VERSION, type FileExtraction} from './extract.js';
import {HAZE_DIR} from '../../config/paths.js';

export interface FileSignature {
  size: number;
  mtimeMs: number;
  hash?: string;
}

export interface GraphManifest {
  extractorVersion: number;
  workspaceRoot: string;
  files: Record<string, FileSignature>;
}

export interface GraphStore {
  dir: string;
  graphPath: string;
  manifestPath: string;
  cacheDir: string;
}

/** Stable directory key for a workspace root (real path, hashed for filename safety). */
export function workspaceGraphKey(root: string): string {
  return createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16);
}

export function graphStoreFor(root: string): GraphStore {
  const dir = path.join(HAZE_DIR, 'graphs', workspaceGraphKey(root));
  return {dir, graphPath: path.join(dir, 'graph.json'), manifestPath: path.join(dir, 'manifest.json'), cacheDir: path.join(dir, 'cache')};
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, target);
}

/** Read the persisted graph; undefined when none exists. Throws on corrupt JSON (caller decides to rebuild). */
export async function readGraph(store: GraphStore): Promise<CodeGraph | undefined> {
  try {
    const raw = await fs.readFile(store.graphPath, 'utf8');
    return parseCodeGraph(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error('graph.json is corrupted; rebuild the graph', {cause: error});
    throw error;
  }
}

export async function readManifest(store: GraphStore): Promise<GraphManifest | undefined> {
  try {
    const raw = await fs.readFile(store.manifestPath, 'utf8');
    const data = JSON.parse(raw) as GraphManifest;
    if (typeof data !== 'object' || data == null || typeof data.files !== 'object') throw new Error('manifest.json is corrupted');
    return data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error('manifest.json is corrupted; rebuild the graph', {cause: error});
    throw error;
  }
}

export interface WriteGraphOptions {
  /** Permit intentional shrink (mass deletion); otherwise a graph that loses most of its nodes is refused. */
  force?: boolean;
}

/**
 * Persist graph + manifest atomically. The shrink guard refuses to replace a
 * healthy graph with a near-empty one unless `force` — a half walk or a parser
 * failure must not silently destroy a good map (mirrors graphify's #479 guard).
 */
export async function writeGraph(store: GraphStore, graph: CodeGraph, manifest: GraphManifest, options: WriteGraphOptions = {}): Promise<void> {
  const previous = await readGraph(store);
  if (!options.force && previous && previous.nodes.length > 500 && graph.nodes.length < previous.nodes.length * 0.5) {
    throw new Error(`Refusing to shrink the code graph from ${previous.nodes.length} to ${graph.nodes.length} nodes. If files were really deleted, rebuild with force.`);
  }
  await writeFileAtomic(store.graphPath, JSON.stringify(graph));
  await writeFileAtomic(store.manifestPath, JSON.stringify({...manifest, extractorVersion: EXTRACTOR_VERSION}));
}

// ---------------------------------------------------------------------------
// Extraction cache: content-hash keyed JSON per file
// ---------------------------------------------------------------------------

function cachePath(store: GraphStore, hash: string): string {
  return path.join(store.cacheDir, `${hash}.json`);
}

export async function readCachedExtraction(store: GraphStore, hash: string): Promise<FileExtraction | undefined> {
  try {
    const raw = await fs.readFile(cachePath(store, hash), 'utf8');
    const data = JSON.parse(raw) as FileExtraction;
    if (data.version !== EXTRACTOR_VERSION) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

export async function writeCachedExtraction(store: GraphStore, hash: string, extraction: FileExtraction): Promise<void> {
  try {
    await writeFileAtomic(cachePath(store, hash), JSON.stringify(extraction));
  } catch {
    // Cache writes are best-effort; a full cache dir must never fail a build.
  }
}

/** Drop cache entries beyond a bounded count (oldest mtime first). */
export async function pruneExtractionCache(store: GraphStore, maxEntries: number): Promise<void> {
  try {
    const entries = await fs.readdir(store.cacheDir).catch(() => [] as string[]);
    if (entries.length <= maxEntries) return;
    const stats = await Promise.all(entries.map(async name => {
      const full = path.join(store.cacheDir, name);
      const stat = await fs.stat(full).catch(() => undefined);
      return {full, mtime: stat?.mtimeMs ?? 0};
    }));
    stats.sort((a, b) => a.mtime - b.mtime);
    for (const entry of stats.slice(0, stats.length - maxEntries)) {
      await fs.rm(entry.full, {force: true});
    }
  } catch {
    // Pruning is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export interface StaleFileSet {
  changed: string[];
  added: string[];
  removed: string[];
}

export interface StalenessReport {
  stale: boolean;
  files: StaleFileSet;
}

/** Compare manifest signatures against the current tree; size/mtime mismatches count as changed. */
export async function computeStaleness(
  store: GraphStore,
  currentSignatures: Record<string, FileSignature>,
): Promise<StalenessReport> {
  const manifest = await readManifest(store);
  if (!manifest) return {stale: true, files: {changed: [], added: [], removed: []}};
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [file, signature] of Object.entries(currentSignatures)) {
    const known = manifest.files[file];
    if (!known) added.push(file);
    else if (known.size !== signature.size || known.mtimeMs !== signature.mtimeMs) changed.push(file);
  }
  for (const file of Object.keys(manifest.files)) {
    if (!(file in currentSignatures)) removed.push(file);
  }
  return {stale: changed.length > 0 || added.length > 0 || removed.length > 0 || manifest.extractorVersion !== EXTRACTOR_VERSION, files: {changed, added, removed}};
}

/** Cheap existence + freshness check used by tool entry points and /map. */
export async function graphStatus(store: GraphStore): Promise<{exists: boolean; stale: boolean; builtAt?: string; nodeCount: number; edgeCount: number; fileCount: number; graph?: CodeGraph}> {
  const graph = await readGraph(store);
  if (!graph) return {exists: false, stale: false, nodeCount: 0, edgeCount: 0, fileCount: 0};
  const files = graph.nodes.filter(node => node.kind === 'file');
  const signatures: Record<string, FileSignature> = {};
  const root = process.cwd();
  for (const node of files) {
    try {
      const absolute = path.join(root, node.file);
      const stat = await fs.stat(absolute);
      signatures[node.file] = {size: stat.size, mtimeMs: stat.mtimeMs};
    } catch {
      // Missing file: leave it out; computeStaleness reports it as removed.
    }
  }
  const staleness = await computeStaleness(store, signatures);
  return {exists: true, stale: staleness.stale, builtAt: graph.builtAt, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, fileCount: files.length, graph};
}
