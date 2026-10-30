import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as settingsModule from '../../src/config/settings.js';
import {runAgentTurn, type StreamCallbacks} from '../../src/cli/commands/streaming.js';
import type {ModelMessage} from 'ai';
import {generateText, streamText, isStepCount, tool} from 'ai';
import {z} from 'zod';
import {discoverHazeBuildManifest, HAZE_BUILD_MODEL} from '../../src/config/hazeBuild.js';
import {modelWithConfig, resolveWorkerRuntime} from '../../src/llm/client.js';
import {harvestModelLimits} from '../../src/config/modelDiscovery.js';
import {providerImageCapable} from '../../src/config/providers.js';
import {createHazeBuildModel} from '../../src/llm/hazeBuild.js';
import {runSubagent} from '../../src/llm/subagentRunner.js';
import {fallbackProviderCapabilities} from '../../src/core/subagent/contracts.js';
vi.mock('../../src/config/paths.js', () => ({HAZE_DIR: `/tmp/haze-native-test-home-${process.pid}`, GLOBAL_SKILLS_DIR: `/tmp/haze-native-test-home-${process.pid}/skills`}));

const descriptor = {schemaVersion: 1, provider: 'haze.build', model: HAZE_BUILD_MODEL,
  modelRepository: 'cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit', modelRevision: 'f1e8415c4f29508fe281da4e256df26573213bfd',
  templateSha256: 'e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259', runtimeVersion: '0.32.0',
  sourceRevision: '0'.repeat(40), scheduler: {maxBatchedTokens: 2048, gpuMemoryUtilization: 0.92, cpuOffloadGb: 0, eager: false},
  contextWindowTokens: 65536, maxOutputTokens: 16384, activeSequences: 3,
  servingProfile: 'concurrent', decodeProfile: 'baseline',
  capabilities: {text: true, tools: true, images: false, thinking: 'binary', preserveThinking: true}} as const;
const provider = {name: 'haze.build', kind: 'haze-build' as const, url: 'https://inference.test/v1', key: 'dummy', models: [HAZE_BUILD_MODEL]};
const settings = {provider: provider.name, model: HAZE_BUILD_MODEL, providers: [provider]};
const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({id: 'reply', created: 1, model: HAZE_BUILD_MODEL, choices: [{index: 0, delta, finish_reason}]})}\n\n`;
const sse = (data: string) => {
  const bytes = new TextEncoder().encode(data);
  // Byte-wise chunks deliberately split UTF-8 characters, JSON and SSE framing.
  return new Response(new ReadableStream({start(c) {for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close();}}), {headers: {'content-type': 'text/event-stream'}});
};
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('native haze.build contract and transport', () => {
  it('refreshes live capacity, bounds settings and carries limits to workers', async () => {
    let context = 65536;
    const fetcher = vi.fn(async () => Response.json({...descriptor, contextWindowTokens: context}));
    vi.stubGlobal('fetch', fetcher);
    const input = {...settings, providers: [{...provider, modelLimits: {[HAZE_BUILD_MODEL]: {contextWindowTokens: 262144, maxOutputTokens: 32768}}}]};
    const first = (await modelWithConfig(undefined, input))!;
    expect(first.config).toMatchObject({contextWindowTokens: 65536, maxOutputTokens: 16384, contextWindowSource: 'deployment'});
    expect(first.config.warnings).toEqual(['Configured context differs from the current haze.build deployment; using the smaller safe limit.',
      'Configured output tokens differ from the current haze.build deployment; using the smaller safe limit.']);
    context = 131072;
    expect((await modelWithConfig(undefined, input))!.config.contextWindowTokens).toBe(131072);
    const worker = await resolveWorkerRuntime({active: first, settings});
    expect(worker).toMatchObject({status: 'found', runtime: {contextWindowTokens: 65536, maxOutputTokens: 16384, nativeMaxConcurrency: 2}});
    expect(fetcher.mock.calls[0][1]).toMatchObject({redirect: 'error'});
  });

  it('rejects incompatible or oversized manifests and invalid transport before sending a key', async () => {
    for (const bad of [{...descriptor, schemaVersion: 2}, {...descriptor, modelRevision: 'a'.repeat(40)}, {...descriptor, capabilities: {...descriptor.capabilities, images: true}}]) {
      await expect(discoverHazeBuildManifest(provider, async () => Response.json(bad))).rejects.toThrow('Incompatible');
    }
    await expect(discoverHazeBuildManifest(provider, async () => new Response('x'.repeat(65537)))).rejects.toThrow('64 KiB');
    const fetcher = vi.fn();
    await expect(discoverHazeBuildManifest({...provider, url: 'http://remote.test/v1'}, fetcher)).rejects.toThrow('plaintext');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('harvests vLLM profile lengths without guessing alias capacity or enabling images', () => {
    for (const context of [65536, 131072, 262144]) expect(harvestModelLimits({data: [{id: HAZE_BUILD_MODEL, max_model_len: context}]})).toEqual({[HAZE_BUILD_MODEL]: {contextWindowTokens: context}});
    for (const value of [0, -1, '262144', 1.5]) expect(harvestModelLimits({data: [{id: HAZE_BUILD_MODEL, max_model_len: value}]})).toEqual({});
    expect(providerImageCapable({...provider, capabilities: {images: true}})).toBe(false);
  });

  it('preserves streamed reasoning, parallel tool IDs, fragmented Unicode and follow-up history through modelWithConfig', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const executed: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/haze/manifest')) return Response.json(descriptor);
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (bodies.length === 1) return sse(event({reasoning: 'Inspect λ files first.'}) +
        event({tool_calls: [{index: 0, id: 'call-A', type: 'function', function: {name: 'read_file', arguments: '{"path":"λ'}}, {index: 1, id: 'call-B', type: 'function', function: {name: 'read_file', arguments: '{"path":"b'}}]}) +
        event({tool_calls: [{index: 0, function: {arguments: '.ts"}'}}, {index: 1, function: {arguments: '.ts"}'}}]}, 'tool_calls') + 'data: [DONE]\n\n');
      return sse(event({reasoning: 'Use both results.'}) + event({content: 'Both inspected.'}, 'stop') +
        'data: '+JSON.stringify({choices: [], usage: {prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: {cached_tokens: 150}, completion_tokens_details: {reasoning_tokens: 10}}})+'\n\ndata: [DONE]\n\n');
    }));
    const selected = (await modelWithConfig(undefined, settings))!;
    const result = streamText({model: selected.model, prompt: 'Inspect both files.', reasoning: 'high', maxOutputTokens: 4096,
      tools: {read_file: tool({inputSchema: z.object({path: z.string()}), execute: async ({path}) => {executed.push(path); return {ok: true, path};}})}, stopWhen: isStepCount(2)});
    const types: string[] = [];
    for await (const part of result.fullStream) types.push(part.type);
    expect(types).toContain('reasoning-delta');
    expect(executed).toEqual(['λ.ts', 'b.ts']);
    expect(await result.text).toBe('Both inspected.');
    expect(bodies[0]).toMatchObject({model: HAZE_BUILD_MODEL, max_tokens: 4096, temperature: 0.6, top_p: 0.95, top_k: 20, chat_template_kwargs: {enable_thinking: true, preserve_thinking: true}});
    const history = bodies[1].messages as Array<Record<string, unknown>>;
    expect(history.find(m => m.role === 'assistant')).toMatchObject({reasoning_content: 'Inspect λ files first.', tool_calls: [expect.objectContaining({id: 'call-A'}), expect.objectContaining({id: 'call-B'})]});
    expect(history.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['call-A', 'call-B']);
    expect((await result.usage).inputTokenDetails.cacheReadTokens).toBe(150);
    expect((await result.usage).outputTokenDetails.reasoningTokens).toBe(10);
  });

  it('maps none to off, unset to default and preserves nonstreaming reasoning', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createHazeBuildModel({baseURL: provider.url, apiKey: 'dummy', manifest: descriptor, fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({choices: [{index: 0, message: {role: 'assistant', reasoning: 'Check.', content: 'Answer.'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 2}});
    }});
    const result = await generateText({model, prompt: 'test', reasoning: 'none'});
    expect(result.reasoningText).toBe('Check.');
    expect(bodies[0].chat_template_kwargs).toEqual({enable_thinking: false, preserve_thinking: true});
    // Thinking-off requests use the model's non-thinking sampler recommendation.
    expect(bodies[0]).toMatchObject({temperature: 0.7, top_p: 0.8});
    await generateText({model, prompt: 'test', reasoning: 'provider-default'});
    expect(bodies[1].chat_template_kwargs).toEqual({preserve_thinking: true});
    // Unset thinking keeps the template default (on) and its thinking samplers.
    expect(bodies[1]).toMatchObject({temperature: 0.6, top_p: 0.95});
  });

  it('retries one transient manifest failure and reports malformed bodies without a raw SyntaxError', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async () => {
      calls.push('attempt');
      if (calls.length === 1) return new Response('proxy hiccup', {status: 503});
      return Response.json(descriptor);
    });
    await expect(discoverHazeBuildManifest(provider, fetcher as unknown as typeof fetch)).resolves.toMatchObject({model: HAZE_BUILD_MODEL});
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(discoverHazeBuildManifest(provider, async () => new Response('<html>gateway error</html>', {status: 200}))).rejects.toThrow('not valid JSON');
  });
});

describe('native provider through the actual Haze agent', () => {
  it('executes a real readFile tool and preserves thinking in the next Haze epoch', async () => {
    const cwd = process.cwd();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-native-agent-'));
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(settingsModule, 'readSettings').mockResolvedValue(settings);
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/haze/manifest')) return Response.json(descriptor);
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? sse(event({reasoning: 'Read the requested fixture.'}) + event({tool_calls: [{index: 0, id: 'read-1', type: 'function', function: {name: 'readFile', arguments: '{"path":"fixture.txt"}'}}]}, 'tool_calls') + 'data: [DONE]\n\n')
        : sse(event({content: 'The fixture contains native fixture marker.'}, 'stop') + 'data: [DONE]\n\n');
    }));
    let conversation: ModelMessage[] = [];
    let last = '';
    const callbacks: StreamCallbacks = {
      addMessage: () => undefined, updateMessage: () => undefined, setBusy: () => undefined,
      debugLog: () => undefined, getConversation: () => conversation, setConversation: value => {conversation = value;},
      getLastAssistantText: () => last, setLastAssistantText: value => {last = value;},
      setAbortController: () => undefined, compactConversation: () => false,
    };
    try {
      vi.spyOn(os, 'homedir').mockReturnValue(workspace);
      await fs.writeFile(path.join(workspace, 'fixture.txt'), 'native fixture marker');
      process.chdir(workspace);
      const result = await runAgentTurn('Read fixture.txt and tell me its contents. Do not edit.', {cwd: workspace, start: new Date()}, [], callbacks);
      expect(result.status).toBe('complete');
      expect(bodies).toHaveLength(2);
      const history = bodies[1].messages as Array<Record<string, unknown>>;
      expect(JSON.stringify(history.find(m => m.role === 'tool'))).toContain('native fixture marker');
      expect(history.find(m => m.role === 'assistant')).toMatchObject({reasoning_content: 'Read the requested fixture.'});
      expect(bodies[0].max_tokens).toBe(16384);
      expect(await fs.readFile(path.join(workspace, 'fixture.txt'), 'utf8')).toBe('native fixture marker');
    } finally {process.chdir(cwd); await fs.rm(workspace, {recursive: true, force: true});}
  });
});

describe('native transport failures', () => {
  it('propagates HTTP errors without following redirects', async () => {
    let redirect: RequestRedirect | undefined;
    const model = createHazeBuildModel({baseURL: provider.url, apiKey: 'dummy', manifest: descriptor,
      fetchImpl: async (_url, init) => {redirect = init?.redirect; return Response.json({error: {message: 'queue full'}}, {status: 429});}});
    await expect(generateText({model, prompt: 'test', maxRetries: 0})).rejects.toThrow();
    expect(redirect).toBe('error');
  });
  it('propagates cancellation to the native fetch', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const model = createHazeBuildModel({baseURL: provider.url, apiKey: 'dummy', manifest: descriptor,
      fetchImpl: async (_url, init) => {
        signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
          controller.abort();
        });
      }});
    await expect(generateText({model, prompt: 'test', abortSignal: controller.signal, maxRetries: 0})).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });
});

describe('native worker context growth', () => {
  it('stops an oversized tool history before another request and keeps worker thinking off', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const model = createHazeBuildModel({baseURL: provider.url, apiKey: 'dummy', manifest: {...descriptor, contextWindowTokens: 4096, maxOutputTokens: 1024},
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sse(event({tool_calls: [{index: 0, id: 'large-1', type: 'function', function: {name: 'read_file', arguments: '{"path":"large.txt"}'}}]}, 'tool_calls')+'data: [DONE]\n\n');
      }});
    const tools = {read_file: tool({inputSchema: z.object({path: z.string()}), execute: async () => 'x'.repeat(24000)})};
    const result = await runSubagent({id: 'worker', objective: 'Inspect a file', deliverable: 'Report findings', mode: 'inspect', scope: [], acceptanceCriteria: []},
      {runtime: {model, selector: 'haze.build:'+HAZE_BUILD_MODEL, providerName: 'haze.build',
        contextWindowTokens: 4096, maxOutputTokens: 1024, requestOptions: {},
        capabilities: {...fallbackProviderCapabilities(), supportsBinaryThinking: true}},
       contextBundle: {systemPrompt: 'Inspect only.', tools, instructions: [], loadedPaths: new Set(), loadedSignatures: new Map(), estimatedTokens: 100, taskTokens: 20, validatedScope: []}});
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({max_tokens: 1024, temperature: 0.7, top_p: 0.8, chat_template_kwargs: {enable_thinking: false}});
    expect(result.capsule.termination).toBe('policy_blocked');
    expect(result.capsule.deliverable).toContain('capacity');
    expect(result.capsule.deliverable).not.toContain('retry this subagent once');
  });
});

describe('native reasoning through endpoint transports', () => {
  it.each(['https://inference.test/v1', 'http://127.0.0.1:8000/v1'])('keeps binary reasoning control for %s', async url => {
    vi.stubGlobal('fetch', async () => Response.json({...descriptor, activeSequences: 1, servingProfile: 'quality'}));
    const nativeSettings = {...settings, providers: [{...provider, url}]};
    const selected = (await modelWithConfig({reasoningOverride: 'none'}, nativeSettings))!;
    expect(selected.config.capabilities.supportsReasoningEffort).toBe(true);
    expect(selected.config.reasoningPolicy.reason).toContain('binary thinking off');
    const worker = await resolveWorkerRuntime({active: selected, settings: nativeSettings});
    expect(worker).toMatchObject({status: 'found', runtime: {nativeMaxConcurrency: 1}});
  });
});
