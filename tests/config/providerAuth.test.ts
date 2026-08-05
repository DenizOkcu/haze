import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

let tmp = '';

async function loadProviderAuth() {
  vi.doMock('../../src/config/paths.js', () => ({HAZE_DIR: tmp, GLOBAL_SKILLS_DIR: path.join(tmp, 'skills')}));
  vi.resetModules();
  return import('../../src/config/providerAuth.js');
}

describe('providerAuth', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-provider-auth-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
    vi.restoreAllMocks();
  });

  it('stores OAuth credentials separately with private permissions', async () => {
    const auth = await loadProviderAuth();
    await auth.setProviderAuth('chatgpt', {type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, accountId: 'account'});

    expect(await auth.getProviderAuth('chatgpt')).toEqual({type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, accountId: 'account'});
    if (process.platform !== 'win32') expect((await fs.stat(auth.PROVIDER_AUTH_FILE)).mode & 0o777).toBe(0o600);
  });

  it('preserves other providers and removes only the selected credential', async () => {
    const auth = await loadProviderAuth();
    await auth.setProviderAuth('a', {type: 'oauth', access: 'a', refresh: 'ra', expires: 1});
    await auth.setProviderAuth('b', {type: 'oauth', access: 'b', refresh: 'rb', expires: 2});
    await auth.removeProviderAuth('a');
    expect(await auth.readProviderAuthStore()).toEqual({b: {type: 'oauth', access: 'b', refresh: 'rb', expires: 2}});
  });

  it('fails loudly for malformed credential files', async () => {
    const auth = await loadProviderAuth();
    await fs.writeJson(auth.PROVIDER_AUTH_FILE, {chatgpt: {type: 'oauth', access: '', refresh: 'r', expires: 1}});
    await expect(auth.readProviderAuthStore()).rejects.toThrow('Failed to read Haze provider authentication');
  });

  it('tightens loose file permissions on read', async () => {
    if (process.platform === 'win32') return; // chmod is a no-op on Windows
    const auth = await loadProviderAuth();
    await fs.ensureDir(path.dirname(auth.PROVIDER_AUTH_FILE));
    await fs.writeJson(auth.PROVIDER_AUTH_FILE, {chatgpt: {type: 'oauth', access: 'a', refresh: 'r', expires: 1}});
    await fs.chmod(auth.PROVIDER_AUTH_FILE, 0o644);
    expect((await fs.stat(auth.PROVIDER_AUTH_FILE)).mode & 0o777).toBe(0o644);
    await auth.getProviderAuth('chatgpt');
    expect((await fs.stat(auth.PROVIDER_AUTH_FILE)).mode & 0o777).toBe(0o600);
  });
});
