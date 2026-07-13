import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {cacheKeyFor, providerRequestSettings, type ModelRuntimeConfig} from '../../src/llm/client.js';

let tmp = '';
let settingsFile = '';

async function loadClient(createOpenAIImpl?: (options: unknown) => unknown) {
  vi.doMock('../../src/config/paths.js', () => ({
    HAZE_DIR: tmp,
    GLOBAL_SKILLS_DIR: path.join(tmp, 'skills'),
  }));
  vi.doMock('@ai-sdk/openai', () => ({
    createOpenAI: vi.fn(createOpenAIImpl ?? ((options: unknown) => ({chat: () => options}))),
  }));
  vi.resetModules();
  return import('../../src/llm/client.js');
}

function config(capabilities: Partial<ModelRuntimeConfig['capabilities']>): ModelRuntimeConfig {
  return {
    providerName: 'test',
    baseURL: 'https://example.test/v1',
    modelName: 'test-model',
    cacheKey: 'stable-cache-key',
    capabilities: {
      reportsCacheUsage: false,
      supportsPromptCacheKey: false,
      supportsExtendedCacheRetention: false,
      supportsStickySessionId: false,
      supportsServerCompaction: false,
      supportsTextVerbosity: false,
      ...capabilities,
    },
  };
}

describe('providerRequestSettings', () => {
  it('adds OpenAI cache and verbosity hints only when supported', () => {
    expect(providerRequestSettings(config({supportsPromptCacheKey: true, supportsTextVerbosity: true}))).toEqual({
      providerOptions: {openai: {promptCacheKey: 'stable-cache-key', textVerbosity: 'low'}},
    });
  });

  it('adds only the cache key when verbosity is unsupported', () => {
    expect(providerRequestSettings(config({supportsPromptCacheKey: true}))).toEqual({
      providerOptions: {openai: {promptCacheKey: 'stable-cache-key'}},
    });
  });

  it('adds only the verbosity when cache key is unsupported', () => {
    expect(providerRequestSettings(config({supportsTextVerbosity: true}))).toEqual({
      providerOptions: {openai: {textVerbosity: 'low'}},
    });
  });

  it('adds a stable sticky-session header only when supported', () => {
    expect(providerRequestSettings(config({supportsStickySessionId: true}))).toEqual({
      headers: {'x-session-id': 'stable-cache-key'},
    });
  });

  it('does not send unsupported provider options', () => {
    expect(providerRequestSettings(config({}))).toEqual({});
  });

  it('combines sticky-session header with OpenAI options when both supported', () => {
    expect(providerRequestSettings(config({supportsStickySessionId: true, supportsPromptCacheKey: true}))).toEqual({
      providerOptions: {openai: {promptCacheKey: 'stable-cache-key'}},
      headers: {'x-session-id': 'stable-cache-key'},
    });
  });
});

describe('cacheKeyFor', () => {
  it('differs when cwd differs and stays stable when cwd is the same', () => {
    const a1 = cacheKeyFor('gpt-4o', '/ws/a');
    const a2 = cacheKeyFor('gpt-4o', '/ws/a');
    const b = cacheKeyFor('gpt-4o', '/ws/b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toHaveLength(32);
  });

  it('changes when the model name changes', () => {
    expect(cacheKeyFor('gpt-4o', '/ws')).not.toBe(cacheKeyFor('gpt-4o-mini', '/ws'));
  });

  it('uses process.cwd() when cwd is omitted', () => {
    const k = cacheKeyFor('gpt-4o');
    expect(k).toHaveLength(32);
    expect(k).toBe(cacheKeyFor('gpt-4o', process.cwd()));
  });
});

describe('modelWithConfig', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-client-test-'));
    settingsFile = path.join(tmp, 'settings.json');
  });

  afterEach(async () => {
    await fs.remove(tmp);
    vi.restoreAllMocks();
  });

  async function writeSettings(payload: unknown) {
    await fs.ensureDir(path.dirname(settingsFile));
    await fs.writeJson(settingsFile, payload, {spaces: 2});
  }

  it('returns undefined when no model is configured', async () => {
    await writeSettings({});
    const {modelWithConfig} = await loadClient();
    expect(await modelWithConfig()).toBeUndefined();
  });

  it('passes apiKey, baseURL, and model to createOpenAI', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'sk-test', models: ['gpt-4o']}],
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig();
    expect(runtime).toBeDefined();
    expect(runtime!.config.providerName).toBe('openai');
    expect(runtime!.config.baseURL).toBe('https://api.openai.com/v1');
    expect(runtime!.config.modelName).toBe('gpt-4o');
  });

  it('sends OpenRouter attribution headers for app statistics', async () => {
    await writeSettings({
      providers: [{name: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'k', models: ['any']}],
      provider: 'openrouter',
      model: 'any',
    });
    const {modelWithConfig} = await loadClient((options: {headers?: Record<string, string>} | undefined) => ({chat: () => options}));
    const runtime = await modelWithConfig();
    const modelArg = runtime!.model as unknown as {headers?: Record<string, string>};
    expect(modelArg.headers).toEqual({
      'HTTP-Referer': 'https://denizokcu.github.io/haze/',
      'X-Title': 'Haze',
    });
  });

  it('falls back to settings.apiKey when the provider has no key', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', models: ['gpt-4o']}],
      apiKey: 'legacy-key',
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient((options: {apiKey?: string} | undefined) => ({chat: () => options}));
    const runtime = await modelWithConfig();
    const modelArg = runtime!.model as unknown as {apiKey?: string};
    expect(modelArg.apiKey).toBe('legacy-key');
  });

  it('uses the not-needed placeholder when no key is available (local OpenAI-compatible)', async () => {
    await writeSettings({
      providers: [{name: 'ollama', url: 'http://localhost:11434/v1', models: ['llama3']}],
      provider: 'ollama',
      model: 'llama3',
    });
    const {modelWithConfig} = await loadClient((options: {apiKey?: string} | undefined) => ({chat: () => options}));
    const runtime = await modelWithConfig();
    const modelArg = runtime!.model as unknown as {apiKey?: string};
    expect(modelArg.apiKey).toBe('not-needed');
  });

  it('detects direct OpenAI by provider name and baseURL', async () => {
    await writeSettings({
      providers: [{name: 'proxy', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o']}],
      provider: 'proxy',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig();
    expect(runtime!.config.capabilities.supportsPromptCacheKey).toBe(true);
    expect(runtime!.config.capabilities.supportsTextVerbosity).toBe(true);
    expect(runtime!.config.capabilities.reportsCacheUsage).toBe(true);
    expect(runtime!.config.capabilities.supportsStickySessionId).toBe(false);
  });

  it('detects OpenRouter by provider name and baseURL', async () => {
    await writeSettings({
      providers: [{name: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'k', models: ['any']}],
      provider: 'openrouter',
      model: 'any',
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig();
    expect(runtime!.config.capabilities.supportsStickySessionId).toBe(true);
    expect(runtime!.config.capabilities.reportsCacheUsage).toBe(true);
    expect(runtime!.config.capabilities.supportsPromptCacheKey).toBe(false);
    expect(runtime!.config.capabilities.supportsTextVerbosity).toBe(false);
  });

  it('returns all-false capabilities for an unrelated provider', async () => {
    await writeSettings({
      providers: [{name: 'custom', url: 'https://example.com/v1', key: 'k', models: ['m']}],
      provider: 'custom',
      model: 'm',
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig();
    expect(runtime!.config.capabilities).toEqual({
      reportsCacheUsage: false,
      supportsPromptCacheKey: false,
      supportsExtendedCacheRetention: false,
      supportsStickySessionId: false,
      supportsServerCompaction: false,
      supportsTextVerbosity: false,
    });
  });

  it('uses the session cwd for the cache key when provided', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o']}],
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    const runtimeA = await modelWithConfig({cwd: '/ws/a'});
    const runtimeB = await modelWithConfig({cwd: '/ws/b'});
    expect(runtimeA!.config.cacheKey).not.toBe(runtimeB!.config.cacheKey);
    expect(runtimeA!.config.cacheKey).toHaveLength(32);
  });

  it('resolves a model override via resolveModelSelector (provider:model)', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o', 'gpt-4o-mini']}],
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig({modelSelector: 'openai:gpt-4o-mini'});
    expect(runtime).toBeDefined();
    expect(runtime!.config.modelName).toBe('gpt-4o-mini');
    expect(runtime!.config.providerName).toBe('openai');
  });

  it('returns undefined for an ambiguous model override', async () => {
    await writeSettings({
      providers: [
        {name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['shared']},
        {name: 'proxy', url: 'https://proxy.test/v1', key: 'k', models: ['shared']},
      ],
      provider: 'openai',
      model: 'shared',
    });
    const {modelWithConfig} = await loadClient();
    expect(await modelWithConfig({modelSelector: 'shared'})).toBeUndefined();
  });

  it('returns undefined for a missing model override', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o']}],
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    expect(await modelWithConfig({modelSelector: 'no-such-model'})).toBeUndefined();
  });

  it('resolves the lightweight slot when configured', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o', 'gpt-4o-mini']}],
      provider: 'openai',
      model: 'gpt-4o',
      models: {lightweight: 'gpt-4o-mini'},
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig({slot: 'lightweight'});
    expect(runtime!.config.modelName).toBe('gpt-4o-mini');
  });

  it('falls back lightweight to primary when the slot is unset', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o']}],
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig({slot: 'lightweight'});
    expect(runtime!.config.modelName).toBe('gpt-4o');
  });

  it('still prefers an explicit modelSelector over a slot', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o', 'gpt-4o-mini']}],
      provider: 'openai',
      model: 'gpt-4o',
      models: {lightweight: 'gpt-4o-mini'},
    });
    const {modelWithConfig} = await loadClient();
    const runtime = await modelWithConfig({slot: 'lightweight', modelSelector: 'openai:gpt-4o'});
    expect(runtime!.config.modelName).toBe('gpt-4o');
  });
});
