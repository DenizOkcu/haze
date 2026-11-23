import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Layer boundaries from src/AGENTS.md, checked on the import graph so a new
// back-edge fails a test instead of only showing up in a review's grep.
const srcRoot = path.join(process.cwd(), 'src');

function sourceFiles(layer: string): string[] {
  const walk = (directory: string): string[] => fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.(ts|tsx)$/.test(entry.name) ? [target] : [];
  });
  return walk(path.join(srcRoot, layer));
}

/** Layers that files under `fromLayer` reach through relative imports (`./x`, ../y/z). */
function importedLayers(fromLayer: string): Array<{file: string; layer: string; specifier: string}> {
  const edges: Array<{file: string; layer: string; specifier: string}> = [];
  for (const file of sourceFiles(fromLayer)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1]!;
      const target = path.relative(srcRoot, path.resolve(path.dirname(file), specifier));
      const layer = target.split(path.sep)[0];
      if (layer && layer !== fromLayer) edges.push({file: path.relative(srcRoot, file), layer, specifier});
    }
  }
  return edges;
}

describe('layer boundaries', () => {
  it('ui never imports from cli (reusable presentation stays below the CLI orchestration layer)', () => {
    expect(importedLayers('ui').filter(edge => edge.layer === 'cli')).toEqual([]);
  });

  it('core, config, skills and utils never import cli, ui, react or ink', () => {
    for (const layer of ['core', 'config', 'skills', 'utils']) {
      const offenders = importedLayers(layer).filter(edge => ['cli', 'ui'].includes(edge.layer));
      expect(offenders, layer).toEqual([]);
      for (const file of sourceFiles(layer)) {
        expect(fs.readFileSync(file, 'utf8'), path.relative(srcRoot, file)).not.toMatch(/from\s*['"](react|ink)['"]/);
      }
    }
  });
});
