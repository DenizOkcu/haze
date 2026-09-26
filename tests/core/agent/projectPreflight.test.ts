import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {projectPreflight} from '../../../src/core/agent/projectPreflight.js';

const created: string[] = [];
afterEach(async () => { for (const dir of created.splice(0)) await fs.rm(dir, {recursive: true, force: true}); });

describe('project preflight', () => {
  it('lists only bounded package script names in the root and child directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-preflight-'));
    created.push(root);
    await fs.mkdir(path.join(root, 'api'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({scripts: {test: 'echo private-secret', build: 'tsc'}}));
    await fs.writeFile(path.join(root, 'api', 'package.json'), JSON.stringify({scripts: {test: 'node --test'}}));
    const text = await projectPreflight(root);
    expect(text).toContain('.: build, test');
    expect(text).toContain('api: test');
    expect(text).not.toContain('private-secret');
  });

  it('skips symlinked package files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-preflight-'));
    created.push(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-preflight-outside-'));
    created.push(outside);
    await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify({scripts: {leak: 'secret'}}));
    await fs.symlink(path.join(outside, 'package.json'), path.join(root, 'package.json'));
    expect(await projectPreflight(root)).toBe('');
  });
});
