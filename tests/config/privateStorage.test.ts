import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {appendPrivateFile, ensurePrivateDir, tightenPrivateFile, writePrivateJsonAtomic} from '../../src/config/privateStorage.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, {recursive: true, force: true}))); });

describe('private storage', () => {
  it('atomically writes and appends private home-state files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-private-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'state.json');
    await writePrivateJsonAtomic(file, {secret: true});
    await appendPrivateFile(file, 'tail');
    expect(await fs.readFile(file, 'utf8')).toContain('tail');
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await fs.readdir(path.dirname(file))).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('tightens existing directory and file modes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-private-mode-'));
    dirs.push(dir);
    const file = path.join(dir, 'state');
    await fs.writeFile(file, 'secret', {mode: 0o644});
    await fs.chmod(dir, 0o755);
    await ensurePrivateDir(dir);
    await tightenPrivateFile(file);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
