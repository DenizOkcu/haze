import {describe, expect, it} from 'vitest';
import {contentHash, extractFile, EXTRACTOR_VERSION} from '../../../src/core/graph/extract.js';

describe('graph extraction', () => {
  it('extracts functions, classes, methods with owners, and typed consts', async () => {
    const extraction = await extractFile('src/demo.ts', [
      'import {helper} from "./util.js";',
      'export interface Options {size: number;}',
      'export type Id = string;',
      'export function main(): void { helper(); }',
      'class Service extends Base {',
      '  count = 0;',
      '  run() { return this.tick(); }',
      '  tick() { return 1; }',
      '}',
      'export const registry = {a: 1};',
      'const ignored = 5;',
    ].join('\n'));
    const names = extraction.symbols.map(symbol => `${symbol.kind}:${symbol.name}${symbol.owner ? `@${symbol.owner}` : ''}`);
    expect(names).toContain('function:main');
    expect(names).toContain('class:Service');
    expect(names).toContain('method:run@Service');
    expect(names).toContain('method:tick@Service');
    expect(names).toContain('field:count@Service');
    expect(names).toContain('type:Options');
    expect(names).toContain('type:Id');
    expect(names).toContain('field:registry');
    expect(names).not.toContain(expect.anything() && 'field:ignored');
    expect(extraction.symbols.filter(symbol => symbol.name === 'ignored')).toHaveLength(0);
  });

  it('collects named, aliased, default, and namespace imports with bindings', async () => {
    const extraction = await extractFile('src/imports.ts', [
      'import defaultExport, {named, aliased as renamed} from "./mod.js";',
      'import * as ns from "./other.js";',
      'export {reExported} from "./deep/lib.js";',
      'import path from "node:path";',
    ].join('\n'));
    expect(extraction.imports).toHaveLength(4);
    const mod = extraction.imports.find(entry => entry.specifier === './mod.js')!;
    expect(mod.defaultImport).toBe('defaultExport');
    expect(mod.bindings).toEqual(expect.arrayContaining([
      {importedName: 'named', localName: 'named'},
      {importedName: 'aliased', localName: 'renamed'},
    ]));
    const ns = extraction.imports.find(entry => entry.specifier === './other.js')!;
    expect(ns.namespaceImport).toBe('ns');
    const reExport = extraction.imports.find(entry => entry.kind === 'export-from')!;
    expect(reExport.specifier).toBe('./deep/lib.js');
    expect(reExport.bindings).toEqual([{importedName: 'reExported', localName: 'reExported'}]);
    // Package imports are recorded but carry no workspace edge downstream.
    expect(extraction.imports.some(entry => entry.specifier === 'node:path')).toBe(true);
  });

  it('collects identifier calls and this.method calls with lines', async () => {
    const extraction = await extractFile('src/calls.ts', [
      'import {run} from "./runner.js";',
      'class App {',
      '  start() { this.boot(); run(); plain(); }',
      '  boot() {}',
      '}',
      'function plain() {}',
    ].join('\n'));
    const boot = extraction.calls.find(call => call.name === 'boot');
    expect(boot?.thisCall).toBe(true);
    expect(extraction.calls.some(call => call.name === 'run' && !call.thisCall)).toBe(true);
    expect(extraction.calls.some(call => call.name === 'plain' && !call.thisCall)).toBe(true);
    // obj.method() calls are deliberately not collected.
    expect(extraction.calls.some(call => call.name === 'method')).toBe(false);
  });

  it('collects extends heritage and export lists', async () => {
    const extraction = await extractFile('src/heritage.ts', [
      'class Local {}',
      'class Child extends Local {}',
      'function exported() {}',
      'const alsoExported = () => 1;',
      'export {exported, alsoExported};',
    ].join('\n'));
    expect(extraction.heritage).toEqual([{name: 'Local', line: 2}]);
    expect(extraction.exports).toEqual(expect.arrayContaining(['exported', 'alsoExported']));
  });

  it('uses tsx grammar for .tsx and js grammar for .js', async () => {
    const tsx = await extractFile('src/ui.tsx', 'export function Comp() { return <div onClick={() => go()}>x</div>; }');
    expect(tsx.symbols.map(symbol => symbol.name)).toContain('Comp');
    expect(tsx.calls.some(call => call.name === 'go')).toBe(true);
    const js = await extractFile('bin/tool.js', 'module.exports = function main() { run(); };');
    expect(js.calls.some(call => call.name === 'run')).toBe(true);
  });

  it('produces stable symbol ids and hashes content deterministically', async () => {
    const source = 'export function one() {}\nexport function one() {}\n';
    const extraction = await extractFile('src/dup.ts', source);
    const ids = extraction.symbols.map(symbol => symbol.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('src/dup.ts#one');
    expect(ids[1]).toMatch(/^src\/dup\.ts#one@\d+/);
    expect(contentHash(source)).toBe(contentHash(source));
    expect(extraction.version).toBe(EXTRACTOR_VERSION);
  });
});
