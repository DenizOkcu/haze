import {afterEach, describe, expect, it, vi} from 'vitest';
import {modelWithConfig, providerRequestSettings, isLocalProviderUrl} from '../../src/llm/client.js';
import {providerReasoningLevels, reasoningLevelsForProvider} from '../../src/config/providerReasoning.js';
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
