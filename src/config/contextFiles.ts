import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {HAZE_DIR} from './paths.js';

export interface ContextFile {
  path: string;
  content: string;
}

export interface ContextFileDiagnostic {
  path: string;
  characters: number;
  estimatedTokens: number;
  contentHash: string;
}

export interface ContextFileDiagnosticsSummary {
  totalCharacters: number;
  totalTokens: number;
  fileCount: number;
  duplicateGroups: Array<{hash: string; paths: string[]}>;
  duplicateFileCount: number;
  windowSize: number | undefined;
  budgetShare: number | undefined;
  exceedsBudget: boolean | undefined;
  budgetThreshold: number;
}

const DEFAULT_BUDGET_THRESHOLD = 0.15;

function resolveBudgetThreshold(explicit?: number) {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.min(1, Math.max(0, explicit));
  const envValue = Number.parseFloat(process.env.HAZE_CONTEXT_BUDGET_SHARE ?? '');
  if (Number.isFinite(envValue)) return Math.min(1, Math.max(0, envValue));
  return DEFAULT_BUDGET_THRESHOLD;
}

const CONTEXT_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_CONTEXT_FILE_CHARS = 20_000;

function uniqueExistingAncestors(fromDir: string) {
  const dirs: string[] = [];
  let current = path.resolve(fromDir);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function displayPath(filePath: string) {
  const home = os.homedir();
  const cwd = process.cwd();
  if (filePath.startsWith(cwd + path.sep) || filePath === cwd) return path.relative(cwd, filePath) || path.basename(filePath);
  if (filePath.startsWith(home + path.sep)) return `~/${path.relative(home, filePath)}`;
  return filePath;
}

export async function readContextFiles(cwd = process.cwd()): Promise<ContextFile[]> {
  const candidates: string[] = [];

  for (const name of CONTEXT_FILE_NAMES) {
    candidates.push(path.join(HAZE_DIR, name));
  }

  for (const dir of uniqueExistingAncestors(cwd)) {
    for (const name of CONTEXT_FILE_NAMES) {
      candidates.push(path.join(dir, name));
    }
  }

  const seen = new Set<string>();
  const contextFiles: ContextFile[] = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!await fs.pathExists(absolute)) continue;
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) continue;
    const content = await fs.readFile(absolute, 'utf8');
    contextFiles.push({
      path: displayPath(absolute),
      content: content.length > MAX_CONTEXT_FILE_CHARS
        ? `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n\n[Context file truncated: ${content.length - MAX_CONTEXT_FILE_CHARS} characters omitted]`
        : content,
    });
  }
  return contextFiles;
}

export function contextFileDiagnostics(files: ContextFile[]): ContextFileDiagnostic[] {
  return files.map(file => ({
    path: file.path,
    characters: file.content.length,
    estimatedTokens: Math.ceil(file.content.length / 4),
    contentHash: crypto.createHash('sha256').update(file.content).digest('hex').slice(0, 12),
  }));
}

export function summarizeContextDiagnostics(
  files: ContextFile[],
  options: {windowSize?: number; budgetThreshold?: number} = {},
): ContextFileDiagnosticsSummary {
  const perFile = contextFileDiagnostics(files);
  const totalCharacters = perFile.reduce((sum, file) => sum + file.characters, 0);
  const totalTokens = perFile.reduce((sum, file) => sum + file.estimatedTokens, 0);

  const byHash = new Map<string, string[]>();
  for (const file of perFile) {
    const existing = byHash.get(file.contentHash);
    if (existing) existing.push(file.path);
    else byHash.set(file.contentHash, [file.path]);
  }
  const duplicateGroups = [...byHash.entries()]
    .filter(([, paths]) => paths.length >= 2)
    .map(([hash, paths]) => ({hash, paths}))
    .sort((a, b) => b.paths.length - a.paths.length || a.hash.localeCompare(b.hash));
  const duplicateFileCount = duplicateGroups.reduce((sum, group) => sum + group.paths.length, 0);

  const budgetThreshold = resolveBudgetThreshold(options.budgetThreshold);
  const windowSize = typeof options.windowSize === 'number' && Number.isFinite(options.windowSize) && options.windowSize > 0
    ? options.windowSize
    : undefined;
  const budgetShare = windowSize ? totalTokens / windowSize : undefined;
  const exceedsBudget = budgetShare == null ? undefined : budgetShare > budgetThreshold;

  return {
    totalCharacters,
    totalTokens,
    fileCount: perFile.length,
    duplicateGroups,
    duplicateFileCount,
    windowSize,
    budgetShare,
    exceedsBudget,
    budgetThreshold,
  };
}
