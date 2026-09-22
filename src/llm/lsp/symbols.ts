import fs from 'node:fs/promises';
import {asRange, isObject, type LspRange} from './protocol.js';

/** A document symbol with a stable hierarchical name path. */
export interface SemanticSymbol {
  name: string;
  namePath: string;
  kind?: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: SemanticSymbol[];
}

function symbolFrom(value: unknown, parents: string[], depth: number): SemanticSymbol | undefined {
  if (!isObject(value) || typeof value.name !== 'string') return undefined;
  const locationRange = isObject(value.location) ? value.location.range : undefined;
  const range = asRange(value.range ?? locationRange);
  if (!range) return undefined;
  const namePath = [...parents, value.name];
  const children = depth !== 0 && Array.isArray(value.children)
    ? value.children.map(child => symbolFrom(child, namePath, depth - 1)).filter((child): child is SemanticSymbol => child != null)
    : undefined;
  return {
    name: value.name,
    namePath: namePath.join('/'),
    kind: typeof value.kind === 'number' ? value.kind : undefined,
    range,
    selectionRange: asRange(value.selectionRange),
    ...(children?.length ? {children} : {}),
  };
}

export function semanticSymbols(values: unknown[], depth = Number.POSITIVE_INFINITY): SemanticSymbol[] {
  return values.map(value => symbolFrom(value, [], depth)).filter((symbol): symbol is SemanticSymbol => symbol != null);
}

export function flattenSemanticSymbols(symbols: readonly SemanticSymbol[]): SemanticSymbol[] {
  const result: SemanticSymbol[] = [];
  const visit = (items: readonly SemanticSymbol[]) => {
    for (const item of items) {
      result.push(item);
      if (item.children) visit(item.children);
    }
  };
  visit(symbols);
  return result;
}

function lastSegment(namePath: string) {
  return namePath.replace(/^\//, '').split('/').at(-1) ?? namePath;
}

export function matchesNamePath(symbol: SemanticSymbol, pattern: string, substring: boolean) {
  const normalized = pattern.replace(/^\//, '');
  if (pattern.startsWith('/')) return symbol.namePath === normalized;
  if (normalized.includes('/')) return symbol.namePath === normalized || symbol.namePath.endsWith(`/${normalized}`);
  return substring ? symbol.name.includes(normalized) : lastSegment(symbol.namePath) === normalized;
}

function rangeContains(outer: LspRange, line: number, character = 1) {
  const startsBefore = line > outer.start.line || (line === outer.start.line && character >= outer.start.character);
  const endsAfter = line < outer.end.line || (line === outer.end.line && character <= outer.end.character);
  return startsBefore && endsAfter;
}

export function smallestContainingSymbol(symbols: readonly SemanticSymbol[], line: number, character = 1) {
  return flattenSemanticSymbols(symbols)
    .filter(symbol => rangeContains(symbol.range, line, character))
    .sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];
}

export async function readRange(absolutePath: string, range: LspRange) {
  const content = await fs.readFile(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, range.start.line - 1), range.end.line).join('\n');
}

export async function readSnippet(absolutePath: string, line: number, contextLines = 1) {
  const content = await fs.readFile(absolutePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, line - contextLines - 1);
  const end = Math.min(lines.length, line + contextLines);
  return lines.slice(start, end).map((text, index) => `${start + index + 1} | ${text}`).join('\n');
}
