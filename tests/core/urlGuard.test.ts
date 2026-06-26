import {describe, expect, it} from 'vitest';
import {validateUrl, isBlockedIp} from '../../src/core/safety/urlGuard.js';

describe('urlGuard validateUrl', () => {
  describe('valid URLs', () => {
    it('accepts a plain https URL', async () => {
      const result = await validateUrl('https://example.com/docs', {lookup: async () => ['93.184.216.34']});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url.hostname).toBe('example.com');
    });

    it('accepts an http URL', async () => {
      const result = await validateUrl('http://example.com', {lookup: async () => ['93.184.216.34']});
      expect(result.ok).toBe(true);
    });

    it('accepts a literal public IPv4', async () => {
      const result = await validateUrl('https://93.184.216.34/docs');
      expect(result.ok).toBe(true);
    });

    it('accepts a literal public IPv6', async () => {
      const result = await validateUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/');
      expect(result.ok).toBe(true);
    });
  });

  describe('invalid_url', () => {
    it('rejects a malformed string with no scheme', async () => {
      const result = await validateUrl('not a url');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('invalid_url');
    });

    it('rejects an empty string', async () => {
      const result = await validateUrl('');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('invalid_url');
    });
  });

  describe('blocked_scheme', () => {
    for (const scheme of ['file', 'data', 'gopher', 'ftp', 'javascript', 'dict']) {
      it(`rejects ${scheme}: scheme`, async () => {
        const result = await validateUrl(`${scheme}://example/x`);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reasonCode).toBe('blocked_scheme');
      });
    }

    it('rejects file:///etc/passwd', async () => {
      const result = await validateUrl('file:///etc/passwd');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_scheme');
    });

    it('rejects a data: URL', async () => {
      const result = await validateUrl('data:text/html,<h1>hi</h1>');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_scheme');
    });
  });

  describe('blocked_address (literal IPs)', () => {
    for (const url of [
      'http://127.0.0.1',
      'http://127.1.2.3',
      'http://0.0.0.0',
      'http://169.254.169.254', // AWS metadata
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://100.64.0.1', // CGNAT
      'http://224.0.0.1', // multicast
      'http://255.255.255.255', // broadcast / reserved
    ]) {
      it(`rejects ${url}`, async () => {
        const result = await validateUrl(url);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
      });
    }

    it('rejects IPv6 loopback [::1]', async () => {
      const result = await validateUrl('http://[::1]');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
    });

    it('rejects IPv6 link-local fe80::1', async () => {
      const result = await validateUrl('http://[fe80::1]');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
    });

    it('rejects IPv6 unique-local fd00::1', async () => {
      const result = await validateUrl('http://[fd00::1]');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
    });

    it('rejects IPv6 unspecified [::]', async () => {
      const result = await validateUrl('http://[::]');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
    });
  });

  describe('blocked_host', () => {
    it('rejects localhost', async () => {
      const result = await validateUrl('http://localhost:3000');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_host');
    });
  });

  describe('DNS resolution (rebinding protection)', () => {
    it('rejects a hostname resolving to a private address', async () => {
      const result = await validateUrl('http://rebind.example', {lookup: async () => ['10.1.2.3']});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
    });

    it('rejects if ANY resolved address is private (mixed records)', async () => {
      const result = await validateUrl('http://mixed.example', {lookup: async () => ['93.184.216.34', '169.254.169.254']});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_address');
    });

    it('accepts a hostname resolving to a public address', async () => {
      const result = await validateUrl('http://public.example', {lookup: async () => ['93.184.216.34']});
      expect(result.ok).toBe(true);
    });

    it('surfaces the resolved addresses on success for pinning', async () => {
      const result = await validateUrl('http://multi.example', {lookup: async () => ['93.184.216.34', '1.1.1.1']});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolvedAddresses).toEqual(['93.184.216.34', '1.1.1.1']);
    });

    it('does not surface resolved addresses for a literal-IP URL', async () => {
      const result = await validateUrl('https://93.184.216.34/docs');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.resolvedAddresses).toBeUndefined();
    });

    it('rejects a hostname that does not resolve', async () => {
      const result = await validateUrl('http://nope.example', {lookup: async () => { throw new Error('ENOTFOUND'); }});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_host');
    });

    it('rejects a hostname that resolves to no addresses', async () => {
      const result = await validateUrl('http://empty.example', {lookup: async () => []});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('blocked_host');
    });
  });
});

describe('urlGuard isBlockedIp', () => {
  it('blocks the cloud metadata address', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
  });

  it('allows a public IPv4', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
  });

  it('returns false for a plain hostname', () => {
    expect(isBlockedIp('example.com')).toBe(false);
  });

  it('blocks an IPv6-mapped loopback', () => {
    expect(isBlockedIp('[::1]')).toBe(true);
  });
});
