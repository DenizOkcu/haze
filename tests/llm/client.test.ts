import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {cacheKeyFor, providerRequestSettings, type ModelRuntimeConfig} from '../../src/llm/client.js';

let tmp = '';
let settingsFile = '';

async function loadClient(
  createOpenAIImpl?: (options: unknown) => unknown,
  createAnthropicImpl?: (options: unknown) => unknown,
) {
  vi.doMock('../../src/config/paths.js', () => ({
    HAZE_DIR: tmp,
    GLOBAL_SKILLS_DIR: path.join(tmp, 'skills'),
  }));
  vi.doMock('@ai-sdk/openai', () => ({
    createOpenAI: vi.fn(createOpenAIImpl ?? ((options: unknown) => ({chat: () => options}))),
  }));
  vi.doMock('@ai-sdk/anthropic', () => ({
    createAnthropic: vi.fn(createAnthropicImpl ?? ((options: unknown) => ({chat: () => options}))),
  }));
  vi.resetModules();
  return import('../../src/llm/client.js');
}

function config(overrides: Partial<ModelRuntimeConfig> & Partial<ModelRuntimeConfig['capabilities']> = {}): ModelRuntimeConfig {
  const {providerName, baseURL, modelName, cacheKey, ...capabilityOverrides} = overrides;
  return {
    providerName: providerName ?? 'test',
    baseURL: baseURL ?? 'https://example.test/v1',
    modelName: modelName ?? 'test-model',
    cacheKey: cacheKey ?? 'stable-cache-key',
    capabilities: {
      reportsCacheUsage: false,
      supportsPromptCacheKey: false,
      supportsExtendedCacheRetention: false,
      supportsStickySessionId: false,
      supportsServerCompaction: false,
      supportsTextVerbosity: false,
      supportsExtendedThinking: false,
      ...capabilityOverrides,
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

  it('enables Anthropic extended thinking for claude-3-7-sonnet models', () => {
    const cfg = config({
      supportsExtendedThinking: true,
      supportsPromptCacheKey: false,
      supportsTextVerbosity: false,
      modelName: 'claude-3-7-sonnet-20250219',
    });
    expect(providerRequestSettings(cfg)).toEqual({
      providerOptions: {
        anthropic: {thinking: {type: 'enabled', budgetTokens: 8000}},
      },
    });
  });

  it('does not enable extended thinking for other Anthropic models', () => {
    const cfg = config({
      supportsExtendedThinking: true,
      modelName: 'claude-opus-4-8',
    });
    expect(providerRequestSettings(cfg)).toEqual({});
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
      supportsExtendedThinking: false,
    });
  });

  it('uses createAnthropic for the Anthropic preset and reports native capabilities', async () => {
    const createAnthropic = vi.fn((options: unknown) => ({chat: () => options}));
    await writeSettings({
      providers: [{name: 'Anthropic Claude', url: 'https://api.anthropic.com/v1', key: 'sk-ant-test', models: ['claude-3-7-sonnet-20250219']}],
      provider: 'Anthropic Claude',
      model: 'claude-3-7-sonnet-20250219',
    });
    const {modelWithConfig} = await loadClient(undefined, createAnthropic);
    const runtime = await modelWithConfig();
    expect(runtime).toBeDefined();
    expect(createAnthropic).toHaveBeenCalledWith({apiKey: 'sk-ant-test'});
    expect((runtime!.model as unknown as {apiKey?: string}).apiKey).toBe('sk-ant-test');
    expect(runtime!.config.capabilities.supportsExtendedThinking).toBe(true);
    expect(runtime!.config.capabilities.reportsCacheUsage).toBe(true);
    expect(runtime!.config.capabilities.supportsPromptCacheKey).toBe(false);
    expect(runtime!.config.capabilities.supportsTextVerbosity).toBe(false);
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
});
