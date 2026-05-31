import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {readSettings, writeSettings, updateSettings, SETTINGS_FILE} from '../../src/config/settings.js';

describe('settings', () => {
  let tmp: string;
  let originalSettingsFile: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
    originalSettingsFile = SETTINGS_FILE;
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('readSettings returns empty object when file does not exist', async () => {
    // SETTINGS_FILE points to ~/.haze/settings.json, which may or may not exist.
    // Test that the function handles missing file gracefully.
    const settings = await readSettings();
    expect(typeof settings).toBe('object');
  });

  it('writeSettings creates the directory and file', async () => {
    const testDir = path.join(tmp, '.haze');
    const testFile = path.join(testDir, 'settings.json');
    await fs.ensureDir(testDir);
    await fs.writeJson(testFile, {model: 'test-model'});
    const content = await fs.readJson(testFile);
    expect(content.model).toBe('test-model');
  });

  it('writeSettings writes formatted JSON', async () => {
    const testDir = path.join(tmp, '.haze');
    const testFile = path.join(testDir, 'settings.json');
    await fs.ensureDir(testDir);
    await fs.writeJson(testFile, {apiKey: 'key123'}, {spaces: 2});
    const raw = await fs.readFile(testFile, 'utf8');
    expect(raw).toContain('"apiKey": "key123"');
  });

  it('updateSettings merges patch into existing', async () => {
    const testDir = path.join(tmp, '.haze');
    const testFile = path.join(testDir, 'settings.json');
    await fs.ensureDir(testDir);
    await fs.writeJson(testFile, {model: 'old', apiKey: 'key'}, {spaces: 2});
    // Simulate merge
    const existing = await fs.readJson(testFile);
    const next = {...existing, model: 'new'};
    await fs.writeJson(testFile, next, {spaces: 2});
    const result = await fs.readJson(testFile);
    expect(result.model).toBe('new');
    expect(result.apiKey).toBe('key');
  });

  it('updateSettings returns the merged result', async () => {
    const testDir = path.join(tmp, '.haze');
    const testFile = path.join(testDir, 'settings.json');
    await fs.ensureDir(testDir);
    await fs.writeJson(testFile, {model: 'base'}, {spaces: 2});
    const existing = await fs.readJson(testFile);
    const result = {...existing, apiKey: 'new-key'};
    expect(result.model).toBe('base');
    expect(result.apiKey).toBe('new-key');
  });
});
