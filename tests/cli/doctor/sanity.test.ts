import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {runStartupSanity} from '../../../src/cli/doctor/sanity.js';

describe('runStartupSanity', () => {
  let tmp: string;
  let originalHazeDir: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sanity-test-'));
    originalHazeDir = process.env.HAZE_DIR;
    process.env.HAZE_DIR = tmp;
  });

  afterEach(async () => {
    process.env.HAZE_DIR = originalHazeDir;
    await fs.remove(tmp);
  });

  it('rotates an oversized log', async () => {
    const logsDir = path.join(tmp, 'logs');
    await fs.ensureDir(logsDir);
    const logFile = path.join(logsDir, '2026-06-27T00-00-00-000Z.jsonl');
    const longLine = JSON.stringify({type: 'request', stream: 'main', payload: 'x'.repeat(200), at: new Date().toISOString()});
    await fs.writeFile(logFile, `${longLine}\n`.repeat(200_000));
    const actions = await runStartupSanity();
    expect(actions.some(a => a.action === 'rotated log')).toBe(true);
  });

  it('prunes an old session file', async () => {
    const sessionsDir = path.join(tmp, 'sessions', 'abcd1234');
    await fs.ensureDir(sessionsDir);
    const oldFile = path.join(sessionsDir, 'old.jsonl');
    await fs.writeFile(oldFile, '');
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, past, past);
    const actions = await runStartupSanity();
    expect(actions.some(a => a.action === 'pruned session' && a.detail.includes('old.jsonl'))).toBe(true);
  });
});
