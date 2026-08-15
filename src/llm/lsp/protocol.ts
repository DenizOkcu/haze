import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {assertRealPathInsideWorkspace, workspaceRelativePath} from '../../utils/path.js';

/**
 * Pure LSP protocol helpers: language/URI mapping, 1-indexed range conversion,
 * location/symbol/diagnostic shaping. No client, process, or filesystem state
 * beyond workspace-relative path resolution.
 */

export function languageId(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.js') return 'javascript';
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.rs') return 'rust';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  return ext.replace(/^\./, '') || 'plaintext';
}

export function toUri(absolutePath: string) {
  return pathToFileURL(absolutePath).toString();
}

export function fromUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try { return workspaceRelativePath(fileURLToPath(uri)); } catch { return uri; }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

export function asRange(value: unknown) {
  if (!isObject(value) || !isObject(value.start) || !isObject(value.end)) return undefined;
  const start = value.start as Record<string, unknown>;
  const end = value.end as Record<string, unknown>;
  return {
    start: {line: typeof start.line === 'number' ? start.line + 1 : 1, character: typeof start.character === 'number' ? start.character + 1 : 1},
    end: {line: typeof end.line === 'number' ? end.line + 1 : 1, character: typeof end.character === 'number' ? end.character + 1 : 1},
  };
}

export function locationToResult(value: unknown) {
  if (!isObject(value)) return undefined;
  const uri = typeof value.uri === 'string' ? value.uri : (typeof value.targetUri === 'string' ? value.targetUri : undefined);
  const range = asRange(value.range ?? value.targetSelectionRange ?? value.targetRange);
  if (!uri || !range) return undefined;
  const resultPath = fromUri(uri);
  const external = !uri.startsWith('file://') || resultPath.startsWith('..') || path.isAbsolute(resultPath);
  return {path: resultPath, range, ...(external ? {external: true} : {})};
}

export async function locationToWorkspaceResult(value: unknown) {
  const result = locationToResult(value);
  if (!result || result.external) return result;
  if (!isObject(value)) return undefined;
  const uri = typeof value.uri === 'string' ? value.uri : (typeof value.targetUri === 'string' ? value.targetUri : undefined);
  if (!uri?.startsWith('file://')) return result;
  try {
    const absolutePath = fileURLToPath(uri);
    await assertRealPathInsideWorkspace(absolutePath, uri);
    return result;
  } catch {
    return {...result, path: uri, external: true as const};
  }
}

export function flattenSymbols(symbols: unknown[], filePath: string, limit: number) {
  const out: Array<{name: string; kind?: number; path: string; range?: ReturnType<typeof asRange>; selectionRange?: ReturnType<typeof asRange>}> = [];
  const visit = (items: unknown[]) => {
    for (const item of items) {
      if (out.length >= limit || !isObject(item)) return;
      if (typeof item.name === 'string') {
        out.push({
          name: item.name,
          kind: typeof item.kind === 'number' ? item.kind : undefined,
          path: filePath,
          range: asRange(item.range),
          selectionRange: asRange(item.selectionRange),
        });
      }
      if (Array.isArray(item.children)) visit(item.children);
    }
  };
  visit(symbols);
  return out;
}

/** Structured, workspace-safe summary of one LSP diagnostic. */
export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'information' | 'hint';
  range: ReturnType<typeof asRange>;
  message: string;
  code?: string;
  source?: string;
}

const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;

export function toDiagnostic(value: unknown): LspDiagnostic | undefined {
  if (!isObject(value)) return undefined;
  const range = asRange(value.range);
  if (!range) return undefined;
  const severity = typeof value.severity === 'number' && value.severity >= 1 && value.severity <= 4
    ? DIAGNOSTIC_SEVERITIES[value.severity - 1]
    : 'information';
  const code = typeof value.code === 'number' || typeof value.code === 'string' ? String(value.code) : undefined;
  const source = typeof value.source === 'string' ? value.source : undefined;
  return {severity, range, message: typeof value.message === 'string' ? value.message : '', ...(code ? {code} : {}), ...(source ? {source} : {})};
}

export function diagnosticsFrom(values: unknown[], limit: number) {
  const out: LspDiagnostic[] = [];
  for (const value of values) {
    if (out.length >= limit) break;
    const diagnostic = toDiagnostic(value);
    if (diagnostic) out.push(diagnostic);
  }
  return out;
}
