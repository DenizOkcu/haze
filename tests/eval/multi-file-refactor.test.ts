import fs from 'node:fs';
import path from 'node:path';
import {describe, expect} from 'vitest';
import {evalIt, runHazeEval, runWorkspaceCommand, writeWorkspaceFile} from './harness.js';

/**
 * Multi-file refactor scenario: a rename must propagate across the module
 * and its consumer while the suite stays green. Exercises coordinated edits
 * plus a final validation — the core loop of real maintenance work.
 */
describe('eval: coordinated multi-file refactor', () => {
  evalIt('renames the function in both files and keeps the suite green', {timeout: 10 * 60_000}, async () => {
    const run = await runHazeEval({
      name: 'multi-file-refactor',
      request: 'Rename the exported function `slugify` to `kebabCase` everywhere it is defined or used (utils.js and consumer.js), keeping the public behavior identical. Make `npm test` pass afterwards. Do not modify the test file.',
      setup(workspace) {
        writeWorkspaceFile(workspace, 'package.json', JSON.stringify({name: 'eval-fixture', private: true, type: 'module', scripts: {test: 'node --test'}}, null, 2) + '\n');
        writeWorkspaceFile(workspace, 'utils.js', [
          '/** String helpers. */',
          '',
          'export function slugify(value) {',
          "  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');",
          '}',
          '',
        ].join('\n'));
        writeWorkspaceFile(workspace, 'consumer.js', [
          "import {slugify} from './utils.js';",
          '',
          '/** Render a page title into a URL-safe slug. */',
          'export function pageTitleSlug(title) {',
          '  return slugify(title);',
          '}',
          '',
        ].join('\n'));
        writeWorkspaceFile(workspace, 'utils.test.js', [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import * as utils from './utils.js';",
          "import {pageTitleSlug} from './consumer.js';",
          '',
          "test('the renamed helper still slugs', () => {",
          "  assert.equal(utils.kebabCase('Hello World!'), 'hello-world');",
          '});',
          '',
          "test('the consumer uses the renamed helper', () => {",
          "  assert.equal(pageTitleSlug('Big Feature'), 'big-feature');",
          '});',
          '',
        ].join('\n'));
      },
    });

    const after = runWorkspaceCommand(run.workspace, 'npm test');
    expect(after.exitCode, `npm test output after run:\n${after.stdout}`).toBe(0);
    expect(run.result.status).toBe('complete');
    expect(run.result.evidence?.validationOutcome).toBe('passed');
    expect(run.result.evidence?.mutationCount).toBeGreaterThanOrEqual(2);
    const utils = fs.readFileSync(path.join(run.workspace, 'utils.js'), 'utf8');
    const consumer = fs.readFileSync(path.join(run.workspace, 'consumer.js'), 'utf8');
    expect(utils).toContain('kebabCase');
    expect(utils).not.toContain('slugify');
    expect(consumer).toContain('kebabCase');
    expect(consumer).not.toContain('slugify');
  });
});
