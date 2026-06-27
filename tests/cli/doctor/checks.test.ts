import {describe, expect, it} from 'vitest';
import {
  checkActiveModel,
  checkContextFiles,
  checkNodeVersion,
  checkProvidersConfigured,
  checkSettingsValid,
} from '../../../src/cli/doctor/checks.js';

describe('doctor checks', () => {
  it('reports critical when no providers configured', async () => {
    const result = await checkProvidersConfigured({});
    expect(result.severity).toBe('critical');
    expect(result.message).toContain('No providers');
  });

  it('reports ok when providers exist', async () => {
    const result = await checkProvidersConfigured({
      providers: [{name: 'openrouter', url: 'https://openrouter.ai/api/v1', models: ['gpt-4o']}],
    });
    expect(result.severity).toBe('ok');
  });

  it('reports critical when activeModel cannot resolve', () => {
    const result = checkActiveModel({providers: [{name: 'p', url: 'u', models: []}]});
    expect(result.severity).toBe('critical');
    expect(result.hint).toContain('models');
  });

  it('reports ok when node version is sufficient', () => {
    const result = checkNodeVersion();
    expect(result.severity).toBe('ok');
  });

  it('reports ok when settings.json is missing', async () => {
    const result = await checkSettingsValid();
    expect(result.severity).toBe('ok');
  });

  it('loads context files without error', async () => {
    const result = await checkContextFiles();
    expect(['ok', 'info']).toContain(result.severity);
  });
});
