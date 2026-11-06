import {describe, expect, it} from 'vitest';
import {resolveGraph} from '../../../src/core/graph/buildGraph.js';
import {extractFile, type FileExtraction} from '../../../src/core/graph/extract.js';

async function extractAll(sources: Record<string, string>): Promise<Map<string, FileExtraction>> {
  const extractions = new Map<string, FileExtraction>();
  for (const [file, content] of Object.entries(sources)) {
    extractions.set(file, await extractFile(file, content));
  }
  return extractions;
}

function edgeBetween(edges: ReturnType<typeof resolveGraph>['edges'], source: string, target: string) {
  return edges.filter(edge => edge.source === source && edge.target === target);
}

describe('graph cross-file resolution', () => {
  it('rewrites NodeNext .js specifiers to .ts files and emits file import edges', async () => {
    const extractions = await extractAll({
      'src/util.ts': 'export function helper() {}\n',
      'src/main.ts': 'import {helper} from "./util.js";\nexport function start() { helper(); }\n',
    });
    const {nodes, edges} = resolveGraph(extractions);
    expect(nodes.map(node => node.id)).toEqual(expect.arrayContaining(['src/util.ts', 'src/main.ts', 'src/util.ts#helper', 'src/main.ts#start']));
    const importEdges = edgeBetween(edges, 'src/main.ts', 'src/util.ts');
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]).toMatchObject({relation: 'imports', confidence: 'EXTRACTED', line: 1});
  });

  it('binds cross-file calls as INFERRED with the call site, same-file calls as EXTRACTED', async () => {
    const extractions = await extractAll({
      'src/util.ts': 'export function helper() {}\n',
      'src/main.ts': [
        'import {helper} from "./util.js";',
        'function local() {}',
        'export function start() { helper(); local(); }',
      ].join('\n'),
    });
    const {edges} = resolveGraph(extractions);
    const cross = edges.find(edge => edge.target === 'src/util.ts#helper' && edge.relation === 'calls');
    expect(cross).toMatchObject({confidence: 'INFERRED', file: 'src/main.ts'});
    expect(cross?.source).toBe('src/main.ts#start');
    expect(cross?.line).toBe(3);
    const sameFile = edges.find(edge => edge.target === 'src/main.ts#local' && edge.relation === 'calls');
    expect(sameFile).toMatchObject({confidence: 'EXTRACTED'});
  });

  it('resolves this.method calls through the enclosing class owner', async () => {
    const extractions = await extractAll({
      'src/app.ts': [
        'class App {',
        '  start() { this.boot(); }',
        '  boot() {}',
        '}',
      ].join('\n'),
    });
    const {edges} = resolveGraph(extractions);
    const bootEdge = edges.find(edge => edge.target === 'src/app.ts#boot' && edge.relation === 'calls');
    expect(bootEdge).toMatchObject({source: 'src/app.ts#start', confidence: 'EXTRACTED', line: 2});
  });

  it('resolves cross-file heritage as INFERRED and local heritage as EXTRACTED', async () => {
    const extractions = await extractAll({
      'src/base.ts': 'export class Base {}\n',
      'src/child.ts': 'import {Base} from "./base.js";\nclass Local {}\nexport class Child extends Base {}\nexport class LocalChild extends Local {}\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges.find(edge => edge.target === 'src/base.ts#Base' && edge.relation === 'inherits'))
      .toMatchObject({confidence: 'INFERRED'});
    expect(edges.find(edge => edge.target === 'src/child.ts#Local' && edge.relation === 'inherits'))
      .toMatchObject({confidence: 'EXTRACTED'});
  });

  it('follows one re-export hop when binding imports', async () => {
    const extractions = await extractAll({
      'src/inner.ts': 'export function core() {}\n',
      'src/barrel.ts': 'export {core} from "./inner.js";\n',
      'src/consumer.ts': 'import {core} from "./barrel.js";\nexport function use() { core(); }\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges.find(edge => edge.target === 'src/inner.ts#core' && edge.relation === 'calls'))
      .toMatchObject({source: 'src/consumer.ts#use', confidence: 'INFERRED'});
  });

  it('defines every symbol from its file and skips unresolved package imports', async () => {
    const extractions = await extractAll({
      'src/solo.ts': 'import fs from "node:fs";\nexport function lone() { return 1; }\n',
    });
    const {edges} = resolveGraph(extractions);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({source: 'src/solo.ts', target: 'src/solo.ts#lone', relation: 'defines'});
  });
});
