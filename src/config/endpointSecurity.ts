function hasCredentials(credentials: unknown): boolean {
  if (typeof credentials === 'string') return credentials.trim().length > 0;
  if (Array.isArray(credentials)) return credentials.some(item => typeof item === 'object' && item != null && 'value' in item && String((item as {value: unknown}).value).trim().length > 0);
  return Boolean(credentials);
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
}

export function assertCredentialedEndpointSecure(urlValue: string, credentials?: unknown): void {
  let url: URL;
  try { url = new URL(urlValue); } catch { throw new Error(`Invalid endpoint URL: ${urlValue}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported endpoint protocol: ${url.protocol}`);
  if (url.protocol === 'http:' && hasCredentials(credentials) && !isLoopbackHostname(url.hostname)) {
    throw new Error(`Refusing to send credentials over plaintext HTTP to remote endpoint ${url.origin}. Use HTTPS or a loopback endpoint.`);
  }
}
