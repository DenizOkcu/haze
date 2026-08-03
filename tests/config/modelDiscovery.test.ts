import {describe, expect, it, vi} from 'vitest';
import {discoverProviderModels, modelsEndpointUrl, parseModelsBody} from '../../src/config/modelDiscovery.js';

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
