import {afterEach, describe, expect, it, vi} from 'vitest';
import {modelWithConfig, providerRequestSettings, isLocalProviderUrl} from '../../src/llm/client.js';
import {providerReasoningLevels, reasoningCapabilitiesForProvider, reasoningLevelsForProvider} from '../../src/config/providerReasoning.js';
import {resolveReasoningCommand} from '../../src/cli/commands/reasoningCommand.js';
import {resolveReasoningChoice} from '../../src/core/agent/reasoningPolicy.js';
import type {HazeProviderSettings} from '../../src/config/settings.js';

const provider = (url: string, extra: Partial<HazeProviderSettings> = {}): HazeProviderSettings => ({name: 'custom', url, models: ['model'], ...extra});
afterEach(() => vi.unstubAllGlobals());

describe('reasoning profiles', () => {
  it('resolves Mistral model levels only for its direct API', () => {
    const url = 'https://api.mistral.ai/v1';
    expect(providerReasoningLevels(url, 'mistral-large-4')).toEqual(['low', 'medium', 'high']);
    expect(providerReasoningLevels(url, 'mistral-small-2603')).toEqual(['none', 'high']);
    expect(providerReasoningLevels(url, 'zai-glm-5-3')).toEqual(['low', 'high', 'max']);
    expect(providerReasoningLevels(url, 'mistral-large-latest')).toBeUndefined();
    expect(providerReasoningLevels('https://gateway.example/v1', 'mistral-large-4')).toBeUndefined();
    expect(reasoningLevelsForProvider(provider(url, {modelReasoningLevels: {'mistral-large-latest': ['high']}}), 'mistral-large-latest')).toEqual(['high']);
  });

  it('does not infer custom provider levels from a model name and honors per-model settings', () => {
    const custom = provider('https://custom.example/v1', {reasoningLevels: ['none', 'high'], modelReasoningLevels: {'gpt-6.1-sol': ['none']}});
    expect(reasoningLevelsForProvider(custom, 'gpt-6.1-sol')).toEqual(['none']);
    expect(reasoningLevelsForProvider(custom, 'model')).toEqual(['none', 'high']);
    expect(reasoningLevelsForProvider(provider('https://custom.example/v1'), 'gpt-6.1-sol')).toEqual([]);
    expect(reasoningLevelsForProvider(provider('https://api.openai.com/v1'), 'gpt-6.1-terra')).toContain('none');
    expect(reasoningLevelsForProvider(provider('https://api.deepseek.com'), 'deepseek-v4-pro')).toEqual(['none', 'low', 'high', 'max']);
    expect(isLocalProviderUrl('http://127.0.0.2:8000/v1')).toBe(true);
    expect(isLocalProviderUrl('http://model.localhost:8000/v1')).toBe(true);
  });

  it('resolves documented Gemini effort and excludes non-reasoning OpenAI models', () => {
    const gemini = provider('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(reasoningLevelsForProvider(gemini, 'gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high']);
    expect(reasoningLevelsForProvider(provider('https://api.openai.com/v1'), 'gpt-4.1')).toEqual([]);
    expect(reasoningCapabilitiesForProvider(gemini, 'unknown').support).toBe('unknown');
    expect(reasoningCapabilitiesForProvider(provider('https://api.openai.com/v1'), 'gpt-4.1').support).toBe('unsupported');
  });

  it('shares endpoint/model facts for suggested models, dated aliases, and explicit overrides', async () => {
    const gemini = provider('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(reasoningLevelsForProvider(gemini, 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    const openai = provider('https://api.openai.com/v1');
    expect(reasoningLevelsForProvider(openai, 'gpt-5.4-mini-2026-03-17')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(reasoningCapabilitiesForProvider({...openai, capabilities: {reasoningEffort: true}}, 'gpt-4.1').support).toBe('supported');
    const mistral = provider('https://api.mistral.ai/v1', {name: 'Mistral Vibe Subscription', models: ['mistral-large-4']});
    const runtime = (await modelWithConfig(undefined, {providers: [mistral], provider: mistral.name, model: 'mistral-large-4'}))!;
    expect(runtime.config).toMatchObject({contextWindowTokens: 1_048_576, maxOutputTokens: 262_144, contextWindowSource: 'preset'});
  });

  it('sends documented effort for the suggested Gemini model', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({id: 'test', object: 'chat.completion', created: 1, model: 'gemini-3.8-flash', choices: [{index: 0, message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}});
    }));
    const gemini = provider('https://generativelanguage.googleapis.com/v1beta/openai', {models: ['gemini-3.8-flash']});
    const runtime = (await modelWithConfig({reasoningOverride: 'high'}, {providers: [gemini], provider: gemini.name, model: 'gemini-3.8-flash'}))!;
    await runtime.model.doGenerate({prompt: [{role: 'user', content: [{type: 'text', text: 'hello'}]}], ...providerRequestSettings(runtime.config)});
    expect(body.reasoning_effort).toBe('high');
  });

  it('rechecks a discovered local context and falls back safely when the probe fails', async () => {
    const custom = provider('http://localhost:11434/v1', {models: ['m'], discoveredModelLimits: {m: {contextWindowTokens: 131_072}}});
    const fetchMock = vi.fn(async (url: unknown) => String(url).endsWith('/api/ps')
      ? Response.json({models: [{name: 'm', context_length: 8192}]})
      : new Response('', {status: 404}));
    vi.stubGlobal('fetch', fetchMock);
    const settings = {providers: [custom], provider: custom.name, model: 'm'};
    const fresh = (await modelWithConfig(undefined, settings))!;
    expect(fresh.config).toMatchObject({contextWindowTokens: 8192, contextWindowSource: 'discovery'});
    fetchMock.mockImplementation(async () => new Response('', {status: 503}));
    const unavailable = (await modelWithConfig(undefined, settings))!;
    expect(unavailable.config).toMatchObject({contextWindowTokens: 32_768, contextWindowSource: 'default-fallback'});
  });

  it('reports an unsupported saved fallback when resetting reasoning', () => {
    const result = resolveReasoningCommand('reset', {current: resolveReasoningChoice('high', 'low'), stored: 'low', supportedLevels: ['none', 'high']});
    expect(result).toMatchObject({action: 'reset', message: expect.stringContaining('unsupported; provider default applies')});
  });

  it('uses the lowest supported worker effort regardless of configuration order', async () => {
    const custom = provider('https://custom.example/v1', {reasoningLevels: ['high', 'low']});
    const runtime = (await modelWithConfig(undefined, {providers: [custom], provider: custom.name, model: 'model'}))!;
    expect(runtime.config.capabilities.workerReasoningEffort).toBe('low');
  });

  it('uses local budgets for LAN endpoints and supports explicit hosted classification', async () => {
    const custom = provider('https://192.168.1.7/v1', {models: ['gpt-5.4']});
    const local = (await modelWithConfig(undefined, {providers: [custom], provider: custom.name, model: 'gpt-5.4'}))!;
    expect(local.config.isLocal).toBe(true);
    expect(local.config.contextWindowTokens).toBe(32_768);
    const hosted = (await modelWithConfig(undefined, {providers: [{...custom, location: 'hosted'}], provider: custom.name, model: 'gpt-5.4'}))!;
    expect(hosted.config.isLocal).toBe(false);
    expect(hosted.config.contextWindowTokens).toBe(1_050_000);
  });

  it('combines explicit, discovered, and catalog limits field by field', async () => {
    const custom = provider('https://custom.example/v1', {models: ['gpt-5.4'], modelLimits: {'gpt-5.4': {maxOutputTokens: 2048}}, discoveredModelLimits: {'gpt-5.4': {contextWindowTokens: 16_000, maxOutputTokens: 8192}}});
    const runtime = (await modelWithConfig(undefined, {providers: [custom], provider: custom.name, model: 'gpt-5.4'}))!;
    expect(runtime.config).toMatchObject({contextWindowTokens: 16_000, maxOutputTokens: 2048, contextWindowSource: 'discovery'});
  });

  it('keeps custom binary settings through selection and sends the configured switch', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({id: 'test', object: 'chat.completion', created: 1, model: 'model', choices: [{index: 0, message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}});
    }));
    const custom = provider('https://custom.example/v1', {reasoningFormat: 'thinking'});
    const runtime = (await modelWithConfig({reasoningOverride: 'none'}, {providers: [custom], provider: custom.name, model: 'model'}))!;
    const options = providerRequestSettings(runtime.config);
    await runtime.model.doGenerate({prompt: [{role: 'user', content: [{type: 'text', text: 'hello'}]}], reasoning: options.reasoning});
    expect(bodies[0]).toMatchObject({thinking: {type: 'disabled'}});
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('uses Responses for direct GPT-6 with stateless reasoning continuity', async () => {
    const requests: Array<{url: string; body: Record<string, unknown>}> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => {
      requests.push({url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>});
      return Response.json({id: 'response', object: 'response', created_at: 1, model: 'gpt-6.1-sol', output: [], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}});
    }));
    const openai = provider('https://api.openai.com/v1', {models: ['gpt-6.1-sol']});
    const runtime = (await modelWithConfig({reasoningOverride: 'high'}, {providers: [openai], provider: openai.name, model: 'gpt-6.1-sol'}))!;
    const options = providerRequestSettings(runtime.config);
    await runtime.model.doGenerate({prompt: [{role: 'user', content: [{type: 'text', text: 'hello'}]}], reasoning: options.reasoning, providerOptions: options.providerOptions});
    expect(requests[0]?.url).toContain('/responses');
    expect(requests[0]?.body).toMatchObject({store: false, reasoning: {effort: 'high'}, include: ['reasoning.encrypted_content']});
  });

  it('sends OpenRouter effort and replays encrypted reasoning details', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({id: 'test', object: 'chat.completion', created: 1, model: 'model', choices: [{index: 0, message: {role: 'assistant', content: 'done'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}});
    }));
    const router = provider('https://openrouter.ai/api/v1');
    const runtime = (await modelWithConfig({reasoningOverride: 'high'}, {providers: [router], provider: router.name, model: 'model'}))!;
    const options = providerRequestSettings(runtime.config);
    await runtime.model.doGenerate({prompt: [
      {role: 'user', content: [{type: 'text', text: 'hello'}]},
      {role: 'assistant', content: [{type: 'text', text: 'thinking'}], providerOptions: {openrouter: {reasoning_details: [{type: 'reasoning.encrypted', data: 'opaque', format: 'openai-responses-v1'}]}}},
    ], providerOptions: options.providerOptions});
    expect(bodies[0]).toMatchObject({reasoning: {effort: 'high'}});
    expect((bodies[0]!.messages as Array<Record<string, unknown>>)[1]).toMatchObject({reasoning_details: [{type: 'reasoning.encrypted', data: 'opaque'}]});
  });
});
