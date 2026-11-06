import {afterEach, expect, it, vi} from 'vitest';
import {streamText, tool} from 'ai';
import {z} from 'zod';
import {modelWithConfig, providerRequestSettings} from '../../src/llm/client.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-flash'],
  ['Kimi Code', 'https://api.kimi.com/coding/v1', 'k3'],
])('replays %s reasoning through a streamed tool call', async (name, url, model) => {
  const bodies: Record<string, unknown>[] = [];
  const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({id: 'r', created: 1, model, choices: [{index: 0, delta, finish_reason}]})}\n\n`;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const response = bodies.length === 1
      ? event({reasoning_content: 'Inspect first.'}) + event({tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'inspect', arguments: '{}'}}]}) + event({}, 'tool_calls')
      : event({content: 'Done.'}) + event({}, 'stop');
    return new Response(`${response}data: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}});
  }));
  const settings = {providers: [{name, url, key: 'test', models: [model]}], provider: name, model};
  const runtime = (await modelWithConfig({reasoningOverride: 'high'}, settings))!;
  const tools = {inspect: tool({description: 'Inspect', inputSchema: z.object({})})};
  const first = streamText({model: runtime.model, messages: [{role: 'user', content: 'Inspect'}], tools, ...providerRequestSettings(runtime.config)});
  await first.consumeStream();
  const response = await first.response;
  const next = streamText({model: runtime.model, messages: [{role: 'user', content: 'Inspect'}, ...response.messages, {role: 'tool', content: [{type: 'tool-result', toolCallId: 'call_1', toolName: 'inspect', output: {type: 'text', value: 'ok'}}]}], tools, ...providerRequestSettings(runtime.config)});
  expect(await next.text).toBe('Done.');
  expect(bodies[1].messages).toContainEqual(expect.objectContaining({role: 'assistant', reasoning_content: 'Inspect first.', tool_calls: [expect.objectContaining({id: 'call_1'})]}));
});
