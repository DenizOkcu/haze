import {describe, expect, it} from 'vitest';
import {assertCredentialedEndpointSecure, isLoopbackHostname} from '../../src/config/endpointSecurity.js';

describe('configured endpoint security', () => {
  it('allows HTTPS, keyless HTTP, and credentialed loopback HTTP', () => {
    expect(() => assertCredentialedEndpointSecure('https://example.com/v1', 'secret')).not.toThrow();
    expect(() => assertCredentialedEndpointSecure('http://example.com/v1')).not.toThrow();
    for (const url of ['http://localhost:1234/v1', 'http://api.localhost/v1', 'http://127.8.9.10/v1', 'http://[::1]/v1']) {
      expect(() => assertCredentialedEndpointSecure(url, 'secret')).not.toThrow();
    }
  });

  it('rejects credentials sent to remote plaintext endpoints', () => {
    expect(() => assertCredentialedEndpointSecure('http://example.com/v1', 'secret')).toThrow(/plaintext HTTP/);
    expect(() => assertCredentialedEndpointSecure('http://localhost.example.com/v1', [{name: 'Authorization', value: 'x'}])).toThrow(/plaintext HTTP/);
    expect(isLoopbackHostname('localhost.example.com')).toBe(false);
  });

  it('rejects invalid and non-HTTP endpoint schemes', () => {
    expect(() => assertCredentialedEndpointSecure('not a url', 'secret')).toThrow(/Invalid endpoint URL/);
    expect(() => assertCredentialedEndpointSecure('ftp://localhost/model', 'secret')).toThrow(/Unsupported endpoint protocol/);
  });

  it('does not mistake adjacent IPv4 ranges for loopback', () => {
    expect(isLoopbackHostname('126.255.255.255')).toBe(false);
    expect(isLoopbackHostname('128.0.0.1')).toBe(false);
    expect(() => assertCredentialedEndpointSecure('http://128.0.0.1/v1', 'secret')).toThrow(/plaintext HTTP/);
  });
});
