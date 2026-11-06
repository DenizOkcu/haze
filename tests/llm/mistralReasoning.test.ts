import {afterEach, expect, it, vi} from 'vitest';
import {streamText} from 'ai';
import {modelWithConfig, providerRequestSettings} from '../../src/llm/client.js';

afterEach(() => vi.unstubAllGlobals());

it('streams Mistral thinking and replays it in the next request as native chunks', async () => {
  const bodies: Record<string, unknown>[] = [];
  const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({id: 'r', created: 1, model: 'mistral-large-4', choices: [{index: 0, delta, finish_reason}]})}\n\n`;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const data = event({content: [{type: 'thinking', thinking: [{type: 'text', text: 'Think first.'}]}]})
      + event({content: [{type: 'thinking', thinking: []}, {type: 'text', text: 'Answer'}]})
      + event({content: ' done.'}) + event({}, 'stop') + 'data: [DONE]\n\n';
    return new Response(data, {headers: {'content-type': 'text/event-stream'}});
  }));
  const settings = {providers: [{name: 'mistral', url: 'https://api.mistral.ai/v1', key: 'test', models: ['mistral-large-4']}], provider: 'mistral', model: 'mistral-large-4'};
  const runtime = (await modelWithConfig({reasoningOverride: 'high'}, settings))!;
  const first = streamText({model: runtime.model, messages: [{role: 'user', content: 'Question'}], ...providerRequestSettings(runtime.config)});
  expect(await first.text).toBe('Answer done.');
  expect(await first.reasoningText).toBe('Think first.');
  const response = await first.response;
  const second = streamText({model: runtime.model, messages: [{role: 'user', content: 'Question'}, ...response.messages, {role: 'user', content: 'Continue'}], ...providerRequestSettings(runtime.config)});
  await second.consumeStream();
  expect(bodies[0]).toMatchObject({reasoning_effort: 'high'});
  expect(bodies[1].messages).toContainEqual(expect.objectContaining({role: 'assistant', content: [
    {type: 'thinking', thinking: [{type: 'text', text: 'Think first.'}]},
    {type: 'text', text: 'Answer done.'},
  ]}));
});

it('sends max for Mistral-hosted GLM through the real compatible SDK', async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response('data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }));
  const model = 'zai-glm-5-3';
  const settings = {providers: [{name: 'mistral', url: 'https://api.mistral.ai/v1', key: 'test', models: [model]}], provider: 'mistral', model};
  const runtime = (await modelWithConfig({reasoningOverride: 'max'}, settings))!;
  await streamText({model: runtime.model, prompt: 'Hi', ...providerRequestSettings(runtime.config)}).consumeStream();
  expect(body.reasoning_effort).toBe('max');
});
