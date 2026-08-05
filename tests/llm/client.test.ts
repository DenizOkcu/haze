import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {providerRequestSettings, type ModelRuntimeConfig} from '../../src/llm/client.js';

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

  it('uses stateless Responses options and provider-managed output limits for ChatGPT Codex', () => {
    expect(providerRequestSettings({...config({}), providerKind: 'chatgpt-codex'})).toEqual({
      omitMaxOutputTokens: true,
      providerOptions: {openai: {store: false, include: ['reasoning.encrypted_content']}},
      headers: {'session-id': 'stable-cache-key'},
    });
  });

  it('combines sticky-session header with OpenAI options when both supported', () => {
    expect(providerRequestSettings(config({supportsStickySessionId: true, supportsPromptCacheKey: true}))).toEqual({
      providerOptions: {openai: {promptCacheKey: 'stable-cache-key'}},
      headers: {'x-session-id': 'stable-cache-key'},
    });
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

  it('uses the Responses model and OAuth fetch for ChatGPT Codex providers', async () => {
    await writeSettings({
      providers: [{name: 'chatgpt', url: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-codex', models: ['gpt-5.4']}],
      provider: 'chatgpt',
      model: 'gpt-5.4',
    });
    const responses = vi.fn((model: string) => ({model}));
    const chat = vi.fn();
    const create = vi.fn((options: unknown) => ({responses, chat, options}));
    const {modelWithConfig} = await loadClient(create);
    const runtime = await modelWithConfig();

    expect(responses).toHaveBeenCalledWith('gpt-5.4');
    expect(chat).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({apiKey: 'haze-oauth-placeholder', fetch: expect.any(Function)}));
    expect(runtime?.config.providerKind).toBe('chatgpt-codex');
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
    const runtimeA2 = await modelWithConfig({cwd: '/ws/a'});
    expect(runtimeA!.config.cacheKey).not.toBe(runtimeB!.config.cacheKey);
    expect(runtimeA!.config.cacheKey).toBe(runtimeA2!.config.cacheKey);
    expect(runtimeA!.config.cacheKey).toHaveLength(32);
  });

  it('changes the cache key when the model name changes', async () => {
    await writeSettings({
      providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o', 'gpt-4o-mini']}],
      provider: 'openai',
      model: 'gpt-4o',
    });
    const {modelWithConfig} = await loadClient();
    const main = await modelWithConfig({cwd: '/ws'});
    const mini = await modelWithConfig({cwd: '/ws', modelSelector: 'openai:gpt-4o-mini'});
    expect(main!.config.cacheKey).not.toBe(mini!.config.cacheKey);
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

  it('intentionally reuses the explicit active model when no worker selector is configured', async () => {
    const settings = {providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['main', 'worker']}], provider: 'openai', model: 'main'};
    await writeSettings(settings);
    const {modelWithConfig, resolveWorkerRuntime} = await loadClient();
    const active = (await modelWithConfig())!;
    const resolved = await resolveWorkerRuntime({active, settings});
    expect(resolved).toMatchObject({status: 'found', runtime: {selector: 'openai:main'}});
  });

  it('resolves an explicit alternate worker and preserves provider request options', async () => {
    const settings = {providers: [{name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['main', 'worker']}], provider: 'openai', model: 'main'};
    await writeSettings(settings);
    const {modelWithConfig, resolveWorkerRuntime} = await loadClient();
    const active = (await modelWithConfig())!;
    const resolved = await resolveWorkerRuntime({active, settings, selector: 'openai:worker'});
    expect(resolved).toMatchObject({status: 'found', runtime: {selector: 'openai:worker', requestOptions: {providerOptions: {openai: {textVerbosity: 'low'}}}}});
  });

  it('blocks missing and ambiguous explicit worker selectors rather than falling back', async () => {
    const settings = {providers: [{name: 'a', url: 'https://a.test/v1', key: 'k', models: ['shared']}, {name: 'b', url: 'https://b.test/v1', key: 'k', models: ['shared']}], provider: 'a', model: 'shared'};
    await writeSettings(settings);
    const {modelWithConfig, resolveWorkerRuntime} = await loadClient();
    const active = (await modelWithConfig())!;
    expect(await resolveWorkerRuntime({active, settings, selector: 'missing'})).toMatchObject({status: 'missing'});
    expect(await resolveWorkerRuntime({active, settings, selector: 'shared'})).toMatchObject({status: 'ambiguous'});
  });
});
