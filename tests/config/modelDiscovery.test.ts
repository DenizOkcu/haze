import {describe, expect, it, vi} from 'vitest';
import {discoverProviderModels, harvestModelLimits, modelsEndpointUrl, ollamaContextFromShow, ollamaModelLimits, parseModelsBody} from '../../src/config/modelDiscovery.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {ok, status, json: () => Promise.resolve(body)} as unknown as Response;
}

describe('modelsEndpointUrl', () => {
  it('appends /models to the configured base URL', () => {
    expect(modelsEndpointUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1/models');
    expect(modelsEndpointUrl('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1/models');
    expect(modelsEndpointUrl(' https://example.com/v1// ')).toBe('https://example.com/v1/models');
  });
});

describe('parseModelsBody', () => {
  it('extracts, dedupes, trims, and sorts model ids', () => {
    const body = {data: [{id: 'zeta'}, {id: 'alpha'}, {id: 'zeta'}, {id: ' beta '}, {id: 42}, {}, null]};
    expect(parseModelsBody(body)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('returns an empty list for unexpected shapes', () => {
    expect(parseModelsBody(undefined)).toEqual([]);
    expect(parseModelsBody({})).toEqual([]);
    expect(parseModelsBody({data: 'nope'})).toEqual([]);
    expect(parseModelsBody({data: [{name: 'x'}]})).toEqual([]);
  });
});

describe('discoverProviderModels', () => {
  it('fetches the models endpoint with the bearer key and returns sorted ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({data: [{id: 'b'}, {id: 'a'}]}));
    const result = await discoverProviderModels({url: 'http://localhost:1234/v1', key: 'secret'}, {fetchImpl});
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.objectContaining({
      headers: {accept: 'application/json', authorization: 'Bearer secret'},
    }));
    expect(result).toEqual({status: 'ok', models: ['a', 'b']});
  });

  it('omits the authorization header for keyless providers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({data: [{id: 'a'}]}));
    await discoverProviderModels({url: 'http://localhost:1234/v1'}, {fetchImpl});
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: {accept: 'application/json'},
    }));
  });

  it('fails closed on HTTP errors, non-JSON bodies, and empty model lists', async () => {
    expect(await discoverProviderModels({url: 'u'}, {fetchImpl: async () => jsonResponse({}, false, 401)})).toEqual({status: 'failed', error: 'endpoint returned HTTP 401'});
    expect(await discoverProviderModels({url: 'u'}, {fetchImpl: async () => ({ok: true, status: 200, json: () => Promise.reject(new Error('bad json'))} as unknown as Response)})).toEqual({status: 'failed', error: 'endpoint returned no JSON'});
    expect(await discoverProviderModels({url: 'u'}, {fetchImpl: async () => jsonResponse({data: []})})).toEqual({status: 'failed', error: 'endpoint returned no models'});
  });

  it('reports timeouts and network errors as failures without throwing', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'});
    expect(await discoverProviderModels({url: 'u'}, {fetchImpl: async () => { throw timeout; }})).toEqual({status: 'failed', error: 'timed out'});
    expect(await discoverProviderModels({url: 'u'}, {fetchImpl: async () => { throw new Error('fetch failed'); }})).toEqual({status: 'failed', error: 'fetch failed'});
  });
});

describe('ollamaContextFromShow', () => {
  it('reads the trained maximum and an explicit num_ctx', () => {
    // Captured from a live ollama 0.32 /api/show for devstral-small-2:latest.
    expect(ollamaContextFromShow({
      parameters: 'temperature                    0.15\nnum_ctx                       131072',
      model_info: {'mistral3.context_length': 393_216, 'mistral3.rope.scaling.original_context_length': 8_192},
    })).toEqual({max: 393_216, numCtx: 131_072});
    // Captured for gemma3:4b — no num_ctx, plain maximum.
    expect(ollamaContextFromShow({
      parameters: 'temperature                    1\ntop_k                          64',
      model_info: {'gemma3.context_length': 131_072},
    })).toEqual({max: 131_072});
  });

  it('ignores junk shapes', () => {
    expect(ollamaContextFromShow(undefined)).toEqual({});
    expect(ollamaContextFromShow({model_info: 'nope'})).toEqual({});
    expect(ollamaContextFromShow({parameters: 'num_ctx zero'})).toEqual({});
  });
});

describe('ollamaModelLimits', () => {
  const psBody = {models: [{name: 'gemma3:4b', model: 'gemma3:4b', context_length: 32_768}]};
  const showMaxOnly = {model_info: {'gemma3.context_length': 131_072}, parameters: ''};
  const showNumCtx = {model_info: {'llama.context_length': 131_072}, parameters: 'num_ctx 8192'};

  function fetchRouting(routes: Record<string, unknown>, fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as {model?: string} : undefined;
    const key = body?.model ? `show:${body.model}` : url;
    const payload = routes[key];
    if (payload === undefined) return {ok: false, status: 404} as unknown as Response;
    return {ok: true, status: 200, json: () => Promise.resolve(payload)} as unknown as Response;
  })) {
    return fetchImpl;
  }

  it('prefers the runtime context from /api/ps, then num_ctx, then a capped model maximum', async () => {
    const fetchImpl = fetchRouting({'http://127.0.0.1:11434/api/ps': psBody, 'show:gemma3:4b': psBody, 'show:withctx': showNumCtx, 'show:maxonly': showMaxOnly});
    const limits = await ollamaModelLimits({baseUrl: 'http://127.0.0.1:11434/v1', models: ['gemma3:4b', 'withctx', 'maxonly'], conservativeCap: 32_768, fetchImpl});
    expect(limits).toEqual({
      'gemma3:4b': {contextWindowTokens: 32_768},
      withctx: {contextWindowTokens: 8_192},
      maxonly: {contextWindowTokens: 32_768},
    });
  });

  it('caps num_ctx by the model maximum and leaves unknown models unset', async () => {
    const showNumCtxAboveMax = {model_info: {'llama.context_length': 8_192}, parameters: 'num_ctx 131072'};
    const fetchImpl = fetchRouting({'http://127.0.0.1:11434/api/ps': {models: []}, 'show:over': showNumCtxAboveMax, 'show:missing': undefined});
    const limits = await ollamaModelLimits({baseUrl: 'http://localhost:11434/v1', models: ['over', 'missing'], conservativeCap: 32_768, fetchImpl});
    expect(limits).toEqual({over: {contextWindowTokens: 8_192}});
  });

  it('returns empty for non-loopback URLs and total failures', async () => {
    expect(await ollamaModelLimits({baseUrl: 'https://api.example.test/v1', models: ['m'], conservativeCap: 32_768})).toEqual({});
    const failing = vi.fn(async () => { throw new Error('connection refused'); });
    expect(await ollamaModelLimits({baseUrl: 'http://127.0.0.1:11434/v1', models: ['m'], conservativeCap: 32_768, fetchImpl: failing})).toEqual({});
  });
});

describe('harvestModelLimits', () => {
  it('harvests documented non-standard fields per provider dialect', () => {
    expect(harvestModelLimits({data: [
      // OpenRouter
      {id: 'or/model', context_length: 262_144, top_provider: {max_completion_tokens: 131_072}},
      // Groq
      {id: 'groq-model', context_window: 131_072},
      // LM Studio
      {id: 'lmstudio-model', max_context_length: 81_920, max_tokens: 4_096},
      // Generic output-only
      {id: 'out-only', max_output_tokens: 16_384},
      // Standard schema: nothing to harvest
      {id: 'plain', created: 1, object: 'model'},
    ]})).toEqual({
      'or/model': {contextWindowTokens: 262_144},
      'groq-model': {contextWindowTokens: 131_072},
      'lmstudio-model': {contextWindowTokens: 81_920, maxOutputTokens: 4_096},
      'out-only': {maxOutputTokens: 16_384},
    });
  });

  it('ignores implausible values and non-integer junk', () => {
    expect(harvestModelLimits({data: [
      {id: 'tiny', context_window: 512},
      {id: 'huge', context_window: 999_999_999},
      {id: 'frac', max_context_length: 131_072.5},
      {id: 'junk', context_window: 'lots'},
      {id: 'neg', max_output_tokens: -1},
    ]})).toEqual({});
  });

  it('is surfaced by discoverProviderModels and omitted when nothing was harvested', async () => {
    const withLimits = vi.fn(async () => jsonResponse({data: [{id: 'm', context_length: 200_000}]}));
    const result = await discoverProviderModels({url: 'u'}, {fetchImpl: withLimits});
    expect(result).toEqual({status: 'ok', models: ['m'], modelLimits: {m: {contextWindowTokens: 200_000}}});

    const without = vi.fn(async () => jsonResponse({data: [{id: 'm'}]}));
    expect(await discoverProviderModels({url: 'u'}, {fetchImpl: without})).toEqual({status: 'ok', models: ['m']});
  });
});
