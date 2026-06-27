import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const testCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-repomap-cache-'));
process.env.HAZE_REPO_MAP_CACHE = path.join(testCacheDir, 'repo-map-cache.json');

const mocks = vi.hoisted(() => ({
  lspWorkspaceSymbols: vi.fn(),
  installedLspServers: vi.fn(),
  readSettings: vi.fn(async () => ({})),
}));

vi.mock('../../src/llm/lsp.js', () => ({
  lspWorkspaceSymbols: mocks.lspWorkspaceSymbols,
}));

vi.mock('../../src/config/lspSettings.js', () => ({
  installedLspServers: mocks.installedLspServers,
}));

vi.mock('../../src/config/settings.js', () => ({
  readSettings: mocks.readSettings,
}));

import {
  extractSymbolsFromSource,
  extractSymbolsViaLsp,
  rankSymbols,
  computeReferenceCounts,
  buildRepoMap,
  type RepoMapSymbol,
} from '../../src/llm/repoMap.js';

describe('extractSymbolsFromSource', () => {
  it('extracts top-level TypeScript declarations', () => {
    const source = [
      'import {z} from "zod";',
      'export interface Config { key: string; }',
      'function helper() { return 1; }',
      'export class Builder {',
      '  private run() {}',
      '}',
      'export const DEFAULT_LIMIT = 100;',
    ].join('\n');

    const symbols = extractSymbolsFromSource('src/app.ts', source);

    expect(symbols.map(symbol => symbol.name)).toEqual(
      expect.arrayContaining(['Config', 'helper', 'Builder', 'DEFAULT_LIMIT'])
    );
    expect(symbols.find(symbol => symbol.name === 'Builder')?.kind).toBe('class');
    expect(symbols.find(symbol => symbol.name === 'Config')?.kind).toBe('interface');
    expect(symbols.find(symbol => symbol.name === 'helper')?.line).toBe(3);
  });

  it('ignores declarations inside string literals', () => {
    const source = 'const x = "export class Fake {}";\nexport class Real {}';
    const symbols = extractSymbolsFromSource('src/fake.ts', source);
    expect(symbols.map(symbol => symbol.name)).not.toContain('Fake');
    expect(symbols.map(symbol => symbol.name)).toContain('Real');
  });

  it('skips comment lines that look like declarations', () => {
    const source = '// export class Commented {}\nexport class Active {}';
    const symbols = extractSymbolsFromSource('src/comment.ts', source);
    expect(symbols.map(symbol => symbol.name)).not.toContain('Commented');
    expect(symbols.map(symbol => symbol.name)).toContain('Active');
  });
});

describe('extractSymbolsViaLsp', () => {
  beforeEach(() => {
    mocks.lspWorkspaceSymbols.mockReset();
    mocks.installedLspServers.mockReset();
    mocks.readSettings.mockReset();
  });

  it('normalizes workspace symbols into RepoMapSymbol rows', async () => {
    mocks.installedLspServers.mockResolvedValue([{name: 'typescript', command: 'typescript-language-server'}]);
    mocks.lspWorkspaceSymbols.mockResolvedValue([
      {name: 'User', kind: 5, path: 'src/models.ts', range: {start: {line: 11, character: 3}}},
    ]);

    const result = await extractSymbolsViaLsp({}, '', 10);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'User',
      kind: 'class',
      path: 'src/models.ts',
      line: 11,
      column: 3,
    });
  });

  it('returns an empty array when no servers are installed', async () => {
    mocks.installedLspServers.mockResolvedValue([]);
    const result = await extractSymbolsViaLsp({}, '', 10);
    expect(result).toEqual([]);
  });

  it('falls back to an empty array when a server throws', async () => {
    mocks.installedLspServers.mockResolvedValue([{name: 'typescript', command: 'typescript-language-server'}]);
    mocks.lspWorkspaceSymbols.mockRejectedValue(new Error('server crashed'));
    const result = await extractSymbolsViaLsp({}, '', 10);
    expect(result).toEqual([]);
  });
});

describe('rankSymbols', () => {
  it('ranks frequently referenced symbols higher', () => {
    const symbols: RepoMapSymbol[] = [
      {name: 'alpha', kind: 'function', path: 'src/a.ts', line: 1, column: 1},
      {name: 'beta', kind: 'function', path: 'src/b.ts', line: 1, column: 1},
    ];
    const refs = new Map([['alpha', 5], ['beta', 1]]);
    const recent = new Set<string>();
    const ranked = rankSymbols(symbols, refs, recent, 10);

    expect(ranked[0]!.name).toBe('alpha');
  });

  it('boosts symbols in recently touched files', () => {
    const symbols: RepoMapSymbol[] = [
      {name: 'old', kind: 'function', path: 'src/old.ts', line: 1, column: 1},
      {name: 'new', kind: 'function', path: 'src/new.ts', line: 1, column: 1},
    ];
    const refs = new Map<string, number>();
    const recent = new Set(['src/new.ts']);
    const ranked = rankSymbols(symbols, refs, recent, 10);

    expect(ranked[0]!.name).toBe('new');
  });

  it('caps the result to maxSymbols', () => {
    const symbols: RepoMapSymbol[] = Array.from({length: 5}, (_, index) => ({
      name: `s${index}`,
      kind: 'function',
      path: `src/${index}.ts`,
      line: 1,
      column: 1,
    }));
    const ranked = rankSymbols(symbols, new Map(), new Set(), 2);
    expect(ranked).toHaveLength(2);
  });
});

describe('computeReferenceCounts', () => {
  it('counts how many times each symbol name appears across sources', async () => {
    const symbols: RepoMapSymbol[] = [
      {name: 'helper', kind: 'function', path: 'src/a.ts', line: 1, column: 1},
    ];
    const counts = await computeReferenceCounts(symbols, new Map([['src/a.ts', 'function helper() {} const x = helper();']]));
    expect(counts.get('helper')).toBe(2);
  });
});

describe('buildRepoMap smoke', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-repomap-'));
    originalCwd = process.cwd();
    process.chdir(tmp);
    await fs.mkdir(path.join(tmp, 'src'), {recursive: true});
    await fs.writeFile(
      path.join(tmp, 'src', 'math.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
      'utf8'
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmp, {recursive: true, force: true});
  });

  it('builds a map for a tiny workspace without LSP', async () => {
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.readSettings.mockResolvedValue({});
    const result = await buildRepoMap({maxSymbols: 50, useLsp: true});
    expect(result.symbols.some(symbol => symbol.name === 'add')).toBe(true);
    expect(result.source).toBe('regex');
  });

  it('uses the LSP source when workspace symbols are returned', async () => {
    mocks.installedLspServers.mockResolvedValue([{name: 'typescript', command: 'typescript-language-server'}]);
    mocks.lspWorkspaceSymbols.mockResolvedValue([
      {name: 'add', kind: 12, path: 'src/math.ts', range: {start: {line: 0, character: 16}}},
    ]);
    const result = await buildRepoMap({maxSymbols: 50, useLsp: true});
    expect(result.source).toBe('lsp');
    expect(result.symbols.some(symbol => symbol.name === 'add')).toBe(true);
  });

  it('reuses cached symbols on a second call with unchanged files', async () => {
    mocks.installedLspServers.mockResolvedValue([]);
    mocks.readSettings.mockResolvedValue({});
    const first = await buildRepoMap({maxSymbols: 50, useLsp: true});
    expect(first.source).toBe('regex');

    const second = await buildRepoMap({maxSymbols: 50, useLsp: true});
    expect(second.symbols).toEqual(first.symbols);
  });
});

afterAll(async () => {
  await fs.rm(testCacheDir, {recursive: true, force: true});
});
