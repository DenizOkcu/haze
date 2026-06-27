import {describe, expect, it} from 'vitest';
import {extractSymbolsFromSource} from '../../src/llm/repoMap.js';

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
