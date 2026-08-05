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

  it('readSettings throws an actionable error for a malformed JSON file', async () => {
    await fs.ensureDir(path.dirname(settingsFile));
    await fs.writeFile(settingsFile, '{not valid', 'utf8');
    const {readSettings} = await loadSettings();
    await expect(readSettings()).rejects.toThrow(`Failed to read Haze settings at ${settingsFile}`);
  });

  it('readSettings throws an actionable error for invalid settings shape', async () => {
    await fs.writeJson(settingsFile, {providers: [{name: 'local', url: 'http://localhost:1234/v1', models: 'llama'}]});
    const {readSettings} = await loadSettings();
    await expect(readSettings()).rejects.toThrow(`Failed to read Haze settings at ${settingsFile}`);
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

  it('validates known subagent profile fields and fails loudly when malformed', async () => {
    await fs.writeJson(settingsFile, {subagents: {defaultProfile: 'local-safe', profiles: {custom: {maxConcurrency: 99}}}});
    const {readSettings} = await loadSettings();
    await expect(readSettings()).rejects.toThrow(`Failed to read Haze settings at ${settingsFile}`);
  });

  it('persists an explicit ChatGPT Codex provider kind', async () => {
    const {writeSettings, readSettings} = await loadSettings();
    await writeSettings({providers: [{name: 'chatgpt', url: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-codex', models: ['gpt-5.4']}]});
    expect((await readSettings()).providers?.[0]?.kind).toBe('chatgpt-codex');
  });

  it('persists provider image capability flags and preserves unknown capability fields', async () => {
    const {writeSettings, readSettings} = await loadSettings();
    await writeSettings({providers: [
      {name: 'cloud', url: 'https://x/v1', models: ['m'], capabilities: {images: true}},
      {name: 'local', url: 'http://localhost:1234/v1', models: ['m'], capabilities: {images: false, audio: true}},
      {name: 'plain', url: 'https://y/v1', models: ['m']},
    ]});
    const settings = await readSettings();
    expect(settings.providers?.[0]?.capabilities).toEqual({images: true});
    // Passthrough keeps unknown capability keys intact.
    expect(settings.providers?.[1]?.capabilities).toMatchObject({images: false, audio: true});
    expect(settings.providers?.[2]?.capabilities).toBeUndefined();
  });

  it('rejects malformed provider capability flags loudly', async () => {
    await fs.writeJson(settingsFile, {providers: [{name: 'p', url: 'https://x/v1', models: ['m'], capabilities: {images: 'yes'}}]});
    const {readSettings} = await loadSettings();
    await expect(readSettings()).rejects.toThrow(`Failed to read Haze settings at ${settingsFile}`);
  });

  it('patches nested subagent/profile fields while preserving unknown fields', async () => {
    const {writeSettings, updateSubagentSettings, readSettings} = await loadSettings();
    await writeSettings({rootPlugin: true, subagents: {pluginField: 'keep', profiles: {custom: {maxConcurrency: 1, pluginProfile: 'keep'}}}});
    await updateSubagentSettings({workerModel: 'local:qwen', profiles: {custom: {maxSteps: 30}}});
    expect(await readSettings()).toMatchObject({
      rootPlugin: true,
      subagents: {workerModel: 'local:qwen', pluginField: 'keep', profiles: {custom: {maxConcurrency: 1, maxSteps: 30, pluginProfile: 'keep'}}},
    });
  });
});
