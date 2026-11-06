/**
 * Graph build orchestration: walk the workspace, extract (cache-first), and
 * resolve cross-file relationships into the final edge set.
 *
 * Safety: the walk reuses the file tools' own confinement — in-process
 * gitignore evaluation, `.git`/`node_modules` skipping (walkDir), cwd
 * confinement, and the shared secret-path refusals — so the graph never reads
 * a file the file tools would refuse. Parsing is deterministic tree-sitter
 * only: no LLM, no network, no shell.
 *
 * Incremental behavior: extraction results are content-hash cached, so a
 * rebuild only re-parses new/changed files; removed files drop out naturally.
 * Cross-file resolution always re-runs — it is cheap and corpus-wide.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {walkDir} from '../../utils/fs.js';
import {workspaceRoot} from '../../utils/path.js';
import {createIgnoreClassifier} from '../../llm/tools/gitIgnore.js';
import {isProtectedSecretPath} from '../safety/secretPaths.js';
import {contentHash, extractFile, isGraphSupportedExtension, EXTRACTOR_VERSION, MAX_SOURCE_BYTES, type FileExtraction} from './extract.js';
import {detectCommunities} from './analyze.js';
import {GRAPH_SCHEMA_VERSION, symbolNodeId, type CodeGraph, type GraphEdge, type GraphNode} from './model.js';
import {graphStoreFor, pruneExtractionCache, readCachedExtraction, writeCachedExtraction, writeGraph, type GraphStore} from './store.js';

/** Upper bound on files considered per build; larger workspaces get a visible partial notice, not a silent hang. */
const GRAPH_MAX_FILES = 20_000;
const EXTRACTION_CACHE_MAX_ENTRIES = 40_000;

export interface GraphBuildOptions {
  /** Permit intentional shrink (mass deletion); otherwise a near-empty rebuild of a healthy graph is refused. */
  force?: boolean;
  /** Progress callback per processed file (used by /map for user feedback). */
  onProgress?: (processed: number, total: number) => void;
}

export interface GraphBuildResult {
  ok: boolean;
  store: GraphStore;
  graph: CodeGraph;
  files: number;
  skippedLarge: number;
  parsedFiles: number;
  cachedFiles: number;
  durationMs: number;
  incremental: boolean;
  capped: boolean;
}

/** Candidate path resolutions for a relative import specifier (extensionless, ESM `.js`-style rewriting, index files). */
function resolveImportSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // package imports carry no workspace edge
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (fileSet.has(base)) return base;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
  // NodeNext ESM rewrites: `./foo.js` may name foo.ts; strip the emitted
  // extension and try every source extension (including the extensionless file).
  for (const emitted of ['.js', '.mjs', '.cjs', '.jsx']) {
    if (base.endsWith(emitted)) {
      const stem = base.slice(0, -emitted.length);
      if (fileSet.has(stem)) return stem;
      for (const extension of extensions) {
        if (fileSet.has(`${stem}${extension}`)) return `${stem}${extension}`;
      }
    }
  }
  for (const extension of extensions) {
    if (fileSet.has(`${base}${extension}`)) return `${base}${extension}`;
  }
  for (const index of ['/index.ts', '/index.tsx', '/index.js']) {
    if (fileSet.has(`${base}${index}`)) return `${base}${index}`;
  }
  return undefined;
}

/** Attribute a source line to the nearest preceding symbol (call/heritage site), else the file node. */
function enclosingSymbolId(extraction: FileExtraction, line: number): string | undefined {
  let best: {id: string; line: number} | undefined;
  for (const symbol of extraction.symbols) {
    if (symbol.line > line) continue;
    if (!best || symbol.line > best.line) best = symbol;
  }
  return best?.id;
}

/** Nearest class whose definition precedes the line — best-effort owner for `this.method()` calls. */
function enclosingClassName(extraction: FileExtraction, line: number): string | undefined {
  let best: {name: string; line: number} | undefined;
  for (const symbol of extraction.symbols) {
    if (symbol.kind !== 'class' || symbol.line > line) continue;
    if (!best || symbol.line > best.line) best = symbol;
  }
  return best?.name;
}

export async function buildWorkspaceGraph(options: GraphBuildOptions = {}): Promise<GraphBuildResult> {
  const started = Date.now();
  const root = workspaceRoot();
  const store = graphStoreFor(root);

  // --- Walk -----------------------------------------------------------------
  const ignoreClassifier = createIgnoreClassifier(root);
  const ignoreBatch = (entries: Parameters<typeof ignoreClassifier.classify>[0]) => ignoreClassifier.classify(entries);
  const walked = await walkDir(root, {recursive: true, maxEntries: GRAPH_MAX_FILES * 3, ignoreBatch});
  const homeDir = os.homedir();
  const sourceFiles = walked
    .filter(entry => entry.isFile && isGraphSupportedExtension(path.extname(entry.name).toLowerCase()))
    .filter(entry => !isProtectedSecretPath(entry.absolutePath, homeDir))
    .map(entry => entry.path.replace(/\\/g, '/'))
    .sort();
  const capped = sourceFiles.length > GRAPH_MAX_FILES;
  const files = capped ? sourceFiles.slice(0, GRAPH_MAX_FILES) : sourceFiles;

  // --- Extract (cache-first) -------------------------------------------------
  const extractions = new Map<string, FileExtraction>();
  let parsedFiles = 0;
  let cachedFiles = 0;
  let skippedLarge = 0;

  for (const [index, file] of files.entries()) {
    options.onProgress?.(index + 1, files.length);
    let content: string;
    try {
      const absolute = path.join(root, file);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_SOURCE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      content = await fs.readFile(absolute, 'utf8');
    } catch {
      continue; // Unreadable file: skip honestly; staleness reports it, builds never fail on one file.
    }
    const hash = contentHash(content);
    const cached = await readCachedExtraction(store, hash);
    let extraction: FileExtraction;
    if (cached && cached.file === file) {
      extraction = cached;
      cachedFiles += 1;
    } else {
      try {
        extraction = await extractFile(file, content);
      } catch {
        continue; // e.g. grammar unavailable; keep building the rest.
      }
      parsedFiles += 1;
      await writeCachedExtraction(store, hash, extraction);
    }
    extractions.set(file, extraction);
  }

  // --- Resolve + persist --------------------------------------------------------
  const {nodes, edges} = resolveGraph(extractions);
  const graph: CodeGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    builtAt: new Date().toISOString(),
    fileCount: files.length,
    nodes,
    edges,
  };
  detectCommunities(graph);

  const signatures: Record<string, {size: number; mtimeMs: number}> = {};
  for (const file of files) {
    try {
      const stat = await fs.stat(path.join(root, file));
      signatures[file] = {size: stat.size, mtimeMs: stat.mtimeMs};
    } catch {
      // Deleted between walk and stat: omit; the next build reports it as removed.
    }
  }
  await writeGraph(store, graph, {extractorVersion: EXTRACTOR_VERSION, workspaceRoot: root, files: signatures}, {force: options.force});
  await pruneExtractionCache(store, EXTRACTION_CACHE_MAX_ENTRIES);

  return {ok: true, store, graph, files: files.length, skippedLarge, parsedFiles, cachedFiles, durationMs: Date.now() - started, incremental: cachedFiles > 0, capped};
}

/**
 * Pure corpus resolution: per-file extractions → graph nodes and edges with
 * cross-file bindings resolved (imports rewritten through NodeNext `.js`
 * specifiers, calls/heritage bound to imported symbols as INFERRED edges).
 */
export function resolveGraph(extractions: Map<string, FileExtraction>): {nodes: GraphNode[]; edges: GraphEdge[]} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileSet = new Set(extractions.keys());

  for (const [file, extraction] of extractions) {
    nodes.push({id: file, label: path.posix.basename(file), kind: 'file', file, line: 1});
    const taken = new Set<string>([file]);
    for (const symbol of extraction.symbols) {
      nodes.push({id: symbolNodeId(file, symbol.name, symbol.line, taken), label: symbol.name, kind: symbol.kind, file, line: symbol.line});
    }
  }

  /** Resolve an exported name in a file to its symbol id (one re-export hop). */
  const resolveExportedSymbol = (targetFile: string, exportedName: string, depth = 0): string | undefined => {
    const target = extractions.get(targetFile);
    if (!target || depth > 1) return undefined;
    const direct = target.symbols.find(symbol => symbol.name === exportedName);
    if (direct) return direct.id;
    for (const reExport of target.imports) {
      if (reExport.kind !== 'export-from') continue;
      const resolved = resolveImportSpecifier(targetFile, reExport.specifier, fileSet);
      if (!resolved) continue;
      const binding = reExport.bindings.find(candidate => candidate.importedName === exportedName);
      if (binding) return resolveExportedSymbol(resolved, binding.importedName, depth + 1);
    }
    return undefined;
  };

  for (const [file, extraction] of extractions) {
    const firstSymbolByName = new Map<string, {id: string; kind: string}>();
    for (const symbol of extraction.symbols) {
      if (!firstSymbolByName.has(symbol.name)) firstSymbolByName.set(symbol.name, {id: symbol.id, kind: symbol.kind});
    }
    // local binding name (imports included) -> symbol id in another file
    const importedBindingToSymbol = new Map<string, string>();

    for (const entry of extraction.imports) {
      if (!entry.specifier.startsWith('.')) continue;
      const targetFile = resolveImportSpecifier(file, entry.specifier, fileSet);
      if (!targetFile) continue;
      edges.push({source: file, target: targetFile, relation: 'imports', confidence: 'EXTRACTED', file, line: entry.line});
      for (const binding of entry.bindings) {
        const targetId = resolveExportedSymbol(targetFile, binding.importedName);
        if (targetId) importedBindingToSymbol.set(binding.localName, targetId);
      }
      if (entry.defaultImport) {
        // Default imports bind to the target's single callable export when
        // unambiguous; several candidates stay unresolved rather than guessed.
        const target = extractions.get(targetFile)!;
        const callables = target.symbols.filter(symbol => target.exports.includes(symbol.name) && (symbol.kind === 'function' || symbol.kind === 'class'));
        const unique = callables.length === 1 ? callables[0] : undefined;
        if (unique) importedBindingToSymbol.set(entry.defaultImport, unique.id);
      }
    }

    for (const call of extraction.calls) {
      const sourceId = enclosingSymbolId(extraction, call.line);
      if (call.thisCall) {
        const className = enclosingClassName(extraction, call.line);
        const targetId = className
          ? extraction.symbols.find(symbol => symbol.name === call.name && symbol.owner === className)?.id
          : undefined;
        if (targetId) edges.push({source: sourceId ?? file, target: targetId, relation: 'calls', confidence: 'EXTRACTED', file, line: call.line});
        continue;
      }
      const importedId = importedBindingToSymbol.get(call.name);
      if (importedId) {
        edges.push({source: sourceId ?? file, target: importedId, relation: 'calls', confidence: 'INFERRED', file, line: call.line});
        continue;
      }
      const local = firstSymbolByName.get(call.name);
      if (local && (local.kind === 'function' || local.kind === 'method' || local.kind === 'class')) {
        edges.push({source: sourceId ?? file, target: local.id, relation: 'calls', confidence: 'EXTRACTED', file, line: call.line});
      }
    }

    for (const heritage of extraction.heritage) {
      const sourceId = enclosingSymbolId(extraction, heritage.line);
      const importedId = importedBindingToSymbol.get(heritage.name);
      const localId = firstSymbolByName.get(heritage.name);
      const target = importedId ?? (localId?.kind === 'class' ? localId.id : undefined);
      if (target) {
        edges.push({source: sourceId ?? file, target, relation: 'inherits', confidence: importedId ? 'INFERRED' : 'EXTRACTED', file, line: heritage.line});
      }
    }

    for (const symbol of extraction.symbols) {
      edges.push({source: file, target: symbol.id, relation: 'defines', confidence: 'EXTRACTED', file, line: symbol.line});
    }
  }

  return {nodes, edges};
}
