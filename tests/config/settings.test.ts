import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

let tmp = '';
let settingsFile = '';

async function loadSettings() {
  vi.doMock('../../src/config/paths.js', () => ({
    get HAZE_DIR() {
      return path.dirname(settingsFile);
    },
    GLOBAL_SKILLS_DIR: '/tmp/haze-skills-test-skipped',
  }));
  vi.resetModules();
  return import('../../src/config/settings.js');
}

describe('settings', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-settings-test-'));
    settingsFile = path.join(tmp, 'settings.json');
  });

  afterEach(async () => {
    await fs.remove(tmp);
    settingsFile = '';
  });

  it('SETTINGS_FILE points to a file under the mocked tmp dir', async () => {
    const {SETTINGS_FILE} = await loadSettings();
    expect(SETTINGS_FILE).toBe(settingsFile);
    expect(SETTINGS_FILE.startsWith(tmp)).toBe(true);
  });

  it('readSettings returns an empty object when the file does not exist', async () => {
    const {readSettings} = await loadSettings();
    expect(await readSettings()).toEqual({});
  });

  it('readSettings returns the existing object when present', async () => {
    await fs.writeJson(settingsFile, {model: 'gpt', apiKey: 'k'});
    const {readSettings} = await loadSettings();
    expect(await readSettings()).toEqual({model: 'gpt', apiKey: 'k'});
  });

  it('readSettings returns {} for a malformed JSON file rather than throwing', async () => {
    await fs.ensureDir(path.dirname(settingsFile));
    await fs.writeFile(settingsFile, '{not valid', 'utf8');
    const {readSettings} = await loadSettings();
    expect(await readSettings()).toEqual({});
  });

  it('writeSettings creates the directory and writes pretty-printed JSON', async () => {
    const {writeSettings} = await loadSettings();
    await writeSettings({model: 'gpt-4o', apiKey: 'abc'});
    const onDisk = await fs.readFile(settingsFile, 'utf8');
    expect(onDisk).toContain('"model": "gpt-4o"');
    expect(onDisk).toContain('"apiKey": "abc"');
    expect(onDisk).toContain('\n');
  });

  it('writeSettings overwrites a previous file', async () => {
    const {writeSettings, readSettings} = await loadSettings();
    await writeSettings({model: 'old'});
    await writeSettings({model: 'new'});
    expect(await readSettings()).toEqual({model: 'new'});
  });

  it('updateSettings merges a patch over the current settings and returns the merged object', async () => {
    const {writeSettings, updateSettings, readSettings} = await loadSettings();
    await writeSettings({model: 'base', apiKey: 'k', provider: 'openai'});
    const merged = await updateSettings({model: 'next'});
    expect(merged).toEqual({model: 'next', apiKey: 'k', provider: 'openai'});
    expect(await readSettings()).toEqual({model: 'next', apiKey: 'k', provider: 'openai'});
  });

  it('updateSettings on a missing file behaves like writeSettings', async () => {
    const {updateSettings, readSettings} = await loadSettings();
    const result = await updateSettings({apiKey: 'fresh'});
    expect(result).toEqual({apiKey: 'fresh'});
    expect(await readSettings()).toEqual({apiKey: 'fresh'});
  });

  it('updateSettings preserves unrelated keys when patching the same object twice', async () => {
    const {updateSettings, readSettings} = await loadSettings();
    await updateSettings({a: 1});
    await updateSettings({b: 2});
    expect(await readSettings()).toEqual({a: 1, b: 2});
  });
});
