import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {readSettings, type HazeSettings} from '../config/settings.js';
import {installedLspServers} from '../config/lspSettings.js';
import {walkDir} from '../utils/fs.js';
import {resolveWorkspacePath, workspaceRoot} from '../utils/path.js';
import {isGitIgnored} from './tools/fileToolShared.js';
import {lspWorkspaceSymbols} from './lsp.js';

const execFile = promisify(execFileCallback);

export type RepoMapSymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'function'
  | 'variable'
  | 'method'
  | 'unknown';

export interface RepoMapSymbol {
  name: string;
  kind: RepoMapSymbolKind;
  path: string;
  line: number;
  column: number;
}

const DECLARATION_PATTERNS: Array<{kind: RepoMapSymbolKind; regex: RegExp}> = [
  {kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/},
  {kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/},
  {kind: 'type', regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/},
  {kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/},
  {kind: 'variable', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/},
  {kind: 'method', regex: /^\s*(?:private\s+|public\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|:)/},
];

function isInsideStringLiteral(line: string, index: number): boolean {
  let inside: '"' | "'" | '`' | undefined;
  let escaped = false;
  for (let i = 0; i < index; i++) {
    const char = line[i];
    if (!char) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inside) {
      if (char === inside) inside = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inside = char;
    }
  }
  return inside !== undefined;
}

function isCommentLine(line: string): boolean {
  return /^\s*\/\//.test(line);
}

export function extractSymbolsFromSource(filePath: string, source: string): RepoMapSymbol[] {
  const symbols: RepoMapSymbol[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (isCommentLine(line)) continue;

    for (const {kind, regex} of DECLARATION_PATTERNS) {
      const match = regex.exec(line);
      if (!match?.[1]) continue;
      const name = match[1];
      const nameIndex = line.indexOf(name, match.index);
      if (nameIndex === -1 || isInsideStringLiteral(line, nameIndex)) continue;

      symbols.push({
        name,
        kind,
        path: filePath,
        line: index + 1,
        column: nameIndex + 1,
      });
      break;
    }
  }

  return symbols;
}

function lspKindToSymbolKind(kind?: number): RepoMapSymbolKind {
  switch (kind) {
    case 5: return 'class';
    case 11: return 'interface';
    case 22: return 'type';
    case 12: return 'function';
    case 13: return 'variable';
    case 6: return 'method';
    case 9: return 'method';
    default: return 'unknown';
  }
}

export async function extractSymbolsViaLsp(
  settings: HazeSettings,
  query: string,
  limit: number
): Promise<RepoMapSymbol[]> {
  const servers = await installedLspServers(settings);
  if (servers.length === 0) return [];

  const results: RepoMapSymbol[] = [];

  for (const server of servers) {
    try {
      const values = await lspWorkspaceSymbols(server, query, limit);
      for (const value of values) {
        results.push({
          name: value.name,
          kind: lspKindToSymbolKind(value.kind),
          path: value.path,
          line: value.range?.start.line ?? 1,
          column: value.range?.start.character ?? 1,
        });
      }
    } catch {
      // Fall through to document-symbol fallback per server.
    }

    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

const CACHE_FILE = process.env.HAZE_REPO_MAP_CACHE
  ? path.resolve(process.env.HAZE_REPO_MAP_CACHE)
  : path.join(os.homedir(), '.haze', 'repo-map-cache.json');

interface RepoMapCacheEntry {
  mtime: number;
  head: string;
  symbols: RepoMapSymbol[];
}

export interface RepoMapOptions {
  path?: string;
  maxSymbols?: number;
  useLsp?: boolean;
}

export interface RepoMapResult {
  symbols: RepoMapSymbol[];
  truncated: boolean;
  source: 'lsp' | 'regex';
}

async function gitHead(): Promise<string> {
  try {
    const {stdout} = await execFile('git', ['-C', workspaceRoot(), 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function recentlyTouchedFiles(maxCommits = 50): Promise<Set<string>> {
  try {
    const {stdout} = await execFile('git', ['-C', workspaceRoot(), 'log', `--max-count=${maxCommits}`, '--format=', '--name-only']);
    return new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function loadCache(): Promise<Record<string, RepoMapCacheEntry>> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as Record<string, RepoMapCacheEntry>;
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, RepoMapCacheEntry>): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), {recursive: true});
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

export function rankSymbols(
  symbols: RepoMapSymbol[],
  referenceCounts: Map<string, number>,
  recentFiles: Set<string>,
  maxSymbols: number
): RepoMapSymbol[] {
  const scored = symbols.map(symbol => {
    const refs = referenceCounts.get(symbol.name) ?? 0;
    const recent = recentFiles.has(symbol.path) ? 10 : 0;
    return {...symbol, score: refs + recent};
  });

  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return scored.slice(0, maxSymbols).map(({score: _score, ...symbol}) => symbol);
}

export async function computeReferenceCounts(
  symbols: RepoMapSymbol[],
  fileContents: Map<string, string>
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const names = new Set(symbols.map(symbol => symbol.name));
  const identifierPattern = /[A-Za-z_$][\w$]*/g;

  for (const content of fileContents.values()) {
    let match: RegExpExecArray | null;
    while ((match = identifierPattern.exec(content)) !== null) {
      const name = match[0];
      if (names.has(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }

  return counts;
}

export async function buildRepoMap(options: RepoMapOptions = {}): Promise<RepoMapResult> {
  const settings = await readSettings();
  const maxSymbols = options.maxSymbols ?? 200;
  const scopeRoot = options.path ? resolveWorkspacePath(options.path) : workspaceRoot();

  let symbols: RepoMapSymbol[] = [];
  let source: 'lsp' | 'regex' = 'regex';

  if (options.useLsp !== false) {
    symbols = await extractSymbolsViaLsp(settings, '', maxSymbols * 2);
    if (symbols.length > 0) source = 'lsp';
  }

  const cache = await loadCache();
  const head = await gitHead();
  const recentFiles = await recentlyTouchedFiles();
  const fileContents = new Map<string, string>();

  if (source === 'regex') {
    const entries = await walkDir(scopeRoot, {
      recursive: true,
      filter: async entry => !await isGitIgnored(entry.absolutePath),
    });

    for (const entry of entries) {
      const cached = cache[entry.path];
      const stat = await fs.stat(entry.absolutePath);

      if (cached && cached.mtime === stat.mtimeMs && cached.head === head) {
        symbols.push(...cached.symbols);
        continue;
      }

      const content = await fs.readFile(entry.absolutePath, 'utf8').catch(() => '');
      const extracted = extractSymbolsFromSource(entry.path, content);
      symbols.push(...extracted);
      fileContents.set(entry.path, content);
      cache[entry.path] = {mtime: stat.mtimeMs, head, symbols: extracted};
    }

    await saveCache(cache);
  }

  for (const symbol of symbols) {
    if (fileContents.has(symbol.path)) continue;
    const absolutePath = path.join(workspaceRoot(), symbol.path);
    const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
    fileContents.set(symbol.path, content);
  }

  const referenceCounts = await computeReferenceCounts(symbols, fileContents);
  const ranked = rankSymbols(symbols, referenceCounts, recentFiles, maxSymbols);

  return {
    symbols: ranked,
    truncated: symbols.length > maxSymbols,
    source,
  };
}
