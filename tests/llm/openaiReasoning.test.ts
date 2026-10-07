import {describe, expect, it, vi} from 'vitest';
import {createOpenAI} from '@ai-sdk/openai';
import {modelWithConfig, providerRequestSettings} from '../../src/llm/client.js';
import type {HazeProviderSettings, HazeSettings} from '../../src/config/settings.js';
import type {StoredReasoningSetting} from '../../src/core/agent/reasoningPolicy.js';

async function runtimeFor(model: string, reasoning?: StoredReasoningSetting, kind?: HazeProviderSettings['kind']) {
  const settings: HazeSettings = {
    providers: [{name: 'test', url: 'https://example.test/v1', models: [model], kind}],
    provider: 'test',
    model,
    ...(reasoning !== undefined ? {reasoning} : {}),
  };
  return (await modelWithConfig(undefined, settings))!;
}

describe('OpenAI model reasoning restrictions', () => {
  it.each(['none', 'minimal'] as const)('omits unsupported %s for gpt-6.1-sol on both transports', async reasoning => {
    for (const kind of [undefined, 'chatgpt-codex'] as const) {
      const runtime = await runtimeFor('gpt-6.1-sol', reasoning, kind);
      expect(runtime.config.reasoningPolicy).toMatchObject({requested: reasoning, effective: 'disabled'});
      expect(runtime.config.reasoningPolicy.reason).toContain('parameter omitted (provider default)');
      expect(runtime.config.reasoningPolicy.reason).toContain('Choose low');
      expect(providerRequestSettings(runtime.config)).not.toHaveProperty('reasoning');
    }
  });

  it.each(['low', 'medium', 'high', 'xhigh'] as const)('preserves supported %s', async reasoning => {
    const runtime = await runtimeFor('gpt-6.1-sol', reasoning, 'chatgpt-codex');
    expect(runtime.config.reasoningPolicy).toMatchObject({requested: reasoning, effective: reasoning});
    expect(providerRequestSettings(runtime.config).reasoning).toBe(reasoning);
  });

  it('preserves the medium default and explicit unset', async () => {
    const defaultRuntime = await runtimeFor('gpt-6.1-sol');
    expect(providerRequestSettings(defaultRuntime.config).reasoning).toBe('medium');
    const unsetRuntime = await runtimeFor('gpt-6.1-sol', 'provider-default');
    expect(unsetRuntime.config.reasoningPolicy).toMatchObject({requested: undefined, effective: 'disabled'});
    expect(providerRequestSettings(unsetRuntime.config)).not.toHaveProperty('reasoning');
  });

  it.each(['gpt-6-sol', 'gpt-6-luna'])('preserves the SDK none exception for %s', async model => {
    const runtime = await runtimeFor(model, 'none');
    expect(providerRequestSettings(runtime.config).reasoning).toBe('none');
    const minimalRuntime = await runtimeFor(model, 'minimal');
    expect(providerRequestSettings(minimalRuntime.config)).not.toHaveProperty('reasoning');
  });

  it.each(['gpt-6', 'gpt-6.1-luna', 'gpt-6-sol-2026-10-01', 'gpt-7'])('matches the SDK restriction for %s', async model => {
    for (const level of ['none', 'minimal'] as const) {
      const runtime = await runtimeFor(model, level);
      expect(providerRequestSettings(runtime.config)).not.toHaveProperty('reasoning');
    }
  });

  it.each(['gpt-5.4', 'custom-model', 'openai/gpt-6.1-sol'])('leaves SDK-unrestricted model %s unchanged', async model => {
    for (const level of ['none', 'minimal'] as const) {
      const runtime = await runtimeFor(model, level);
      expect(providerRequestSettings(runtime.config).reasoning).toBe(level);
    }
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'provider-default'] as const)('sends %s through the real Responses SDK without an effort warning', async reasoning => {
    const runtime = await runtimeFor('gpt-6.1-sol', reasoning, 'chatgpt-codex');
    const options = providerRequestSettings(runtime.config);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'resp_test',
      object: 'response',
      created_at: 0,
      model: 'gpt-6.1-sol',
      output: [],
      usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
    }), {headers: {'content-type': 'application/json'}}));
    const sdkModel = createOpenAI({apiKey: 'test', fetch: fetchImpl}).responses('gpt-6.1-sol');
    const result = await sdkModel.doGenerate({
      prompt: [{role: 'user', content: [{type: 'text', text: 'hello'}]}],
      reasoning: options.reasoning,
      providerOptions: options.providerOptions,
    });
    expect(result.warnings.filter(warning => warning.type === 'unsupported' && warning.feature === 'reasoningEffort')).toEqual([]);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    if (reasoning === 'none' || reasoning === 'minimal' || reasoning === 'provider-default') {
      expect(body).not.toHaveProperty('reasoning.effort');
    } else {
      expect(body.reasoning.effort).toBe(reasoning);
    }
  });
});
