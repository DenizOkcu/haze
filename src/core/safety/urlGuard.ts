import {promises as dns} from 'node:dns';

/**
 * SSRF guard for the `fetch` tool.
 *
 * Network tools have no workspace path, so they need a *different* confinement
 * than the file tools: scheme allowlist + private/loopback/link-local address
 * blocking + DNS-resolution check (defeats DNS rebinding to internal IPs).
 *
 * This module is pure safety logic under `core/safety/`, parallel to
 * `bashClassifier.ts`. It must not import anything from `ai`, `hazeTools`, or
 * the UI — keep it auditable in one place.
 */

export type UrlValidation =
  | {ok: true; url: URL; resolvedAddresses?: string[]}
  | {
      ok: false;
      reasonCode: 'invalid_url' | 'blocked_scheme' | 'blocked_host' | 'blocked_address';
      reason: string;
    };

export type DnsLookupFn = (
  hostname: string,
) => Promise<string[]>;

/**
 * Blocked IPv4 and IPv6 ranges as CIDR strings. Centralized so the policy reads
 * in one place. Covers loopback, link-local, private, and other non-routable /
 * metadata-bearing ranges (e.g. 169.254.169.254 = AWS/cloud metadata).
 */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<{start: number; mask: number; bits: number}> = [
  parseIpv4Cidr('0.0.0.0/8'), // "this network"
  parseIpv4Cidr('10.0.0.0/8'), // private
  parseIpv4Cidr('100.64.0.0/10'), // CGNAT
  parseIpv4Cidr('127.0.0.0/8'), // loopback
  parseIpv4Cidr('169.254.0.0/16'), // link-local / cloud metadata
  parseIpv4Cidr('172.16.0.0/12'), // private
  parseIpv4Cidr('192.0.0.0/24'), // IETF protocol assignments
  parseIpv4Cidr('192.0.2.0/24'), // TEST-NET-1
  parseIpv4Cidr('192.168.0.0/16'), // private
  parseIpv4Cidr('198.18.0.0/15'), // benchmarking
  parseIpv4Cidr('198.51.100.0/24'), // TEST-NET-2
  parseIpv4Cidr('203.0.113.0/24'), // TEST-NET-3
  parseIpv4Cidr('224.0.0.0/4'), // multicast
  parseIpv4Cidr('240.0.0.0/4'), // reserved
];

const BLOCKED_IPV6_CIDRS: ReadonlyArray<{start: bigint; mask: bigint; bits: number}> = [
  parseIpv6Cidr('::/128'), // unspecified
  parseIpv6Cidr('::1/128'), // loopback
  parseIpv6Cidr('::ffff:0:0/96'), // IPv4-mapped (checked via v4 ranges too, but be explicit)
  parseIpv6Cidr('64:ff9b::/96'), // NAT64
  parseIpv6Cidr('100::/64'), // discard prefix
  parseIpv6Cidr('fc00::/7'), // unique local
  parseIpv6Cidr('fe80::/10'), // link-local
  parseIpv6Cidr('ff00::/8'), // multicast
];

/** Hostnames that are always blocked regardless of resolution. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

function parseIpv4Cidr(cidr: string) {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const octets = ip!.split('.').map(Number);
  const start = (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return {start: (start & mask) >>> 0, mask, bits};
}

function parseIpv6Cidr(cidr: string) {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const num = ipv6ToBigInt(ip!);
  const mask = bits === 0 ? 0n : ((0xffffffffffffffffffffffffffffffffn << BigInt(128 - bits)) & 0xffffffffffffffffffffffffffffffffn);
  return {start: num & mask, mask, bits};
}

function ipv4ToInt(ip: string): number | undefined {
  const octets = ip.split('.');
  if (octets.length !== 4) return undefined;
  const nums = octets.map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return (((nums[0]! << 24) >>> 0) + (nums[1]! << 16) + (nums[2]! << 8) + nums[3]!) >>> 0;
}

function ipv6ToBigInt(ip: string): bigint {
  const normalized = normalizeIpv6(ip);
  const parts = normalized.split(':');
  const groups = parts.map(part => BigInt(parseInt(part || '0', 16)));
  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) + group;
  }
  return result;
}

function normalizeIpv6(ip: string): string {
  if (!ip.includes(':')) return ip;
  let expanded = ip;
  // Handle IPv4-in-IPv6 dotted quad in the last group.
  const lastColon = expanded.lastIndexOf(':');
  const tail = expanded.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 != null) {
      const g1 = (v4 >> 16) & 0xffff;
      const g2 = v4 & 0xffff;
      expanded = `${expanded.slice(0, lastColon + 1)}${g1.toString(16)}:${g2.toString(16)}`;
    }
  }
  // Expand :: shorthand.
  if (expanded.includes('::')) {
    const [head, tail2] = expanded.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail2 ? tail2.split(':') : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    expanded = [...headGroups, ...Array.from({length: missing}, () => '0'), ...tailGroups].join(':');
  }
  return expanded;
}

function isIpv6(ip: string): boolean {
  return ip.includes(':');
}

function ipv4InBlockedRange(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value == null) return false;
  for (const range of BLOCKED_IPV4_CIDRS) {
    if ((value & range.mask) >>> 0 === range.start) return true;
  }
  return false;
}

function ipv6InBlockedRange(ip: string): boolean {
  let num: bigint;
  try {
    num = ipv6ToBigInt(ip);
  } catch {
    return false;
  }
  for (const range of BLOCKED_IPV6_CIDRS) {
    if ((num & range.mask) === range.start) return true;
  }
  return false;
}

/**
 * Check whether a literal IP address (v4 or v6) is in a blocked range.
 * Returns false for non-IP strings (hostnames are resolved separately).
 */
export function isBlockedIp(ip: string): boolean {
  // Strip IPv6 bracket form for literal checks.
  const cleaned = ip.replace(/^\[|\]$/g, '');
  if (isIpv6(cleaned)) return ipv6InBlockedRange(cleaned);
  return ipv4InBlockedRange(cleaned);
}

function hostLooksLikeIp(host: string): boolean {
  const cleaned = host.replace(/^\[|\]$/g, '');
  if (cleaned.includes(':')) return true; // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned);
}

const defaultLookup: DnsLookupFn = async hostname => {
  const records = await dns.lookup(hostname, {all: true});
  return records.map(record => record.address);
};

/**
 * Validate a URL for outbound fetching.
 *
 * Checks scheme allowlist, blocks well-known dangerous hostnames, blocks
 * literal private/loopback/link-local IPs, and (if the host is a DNS name)
 * resolves it to reject names that point at private/loopback/link-local IPs.
 *
 * `lookup` is injectable for deterministic offline tests.
 */
export async function validateUrl(
  input: string,
  options?: {lookup?: DnsLookupFn},
): Promise<UrlValidation> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {ok: false, reasonCode: 'invalid_url', reason: `Not a valid URL: ${input}`};
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reasonCode: 'blocked_scheme',
      reason: `Scheme '${url.protocol.replace(':', '')}' is not allowed; only http and https are permitted.`,
    };
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return {ok: false, reasonCode: 'blocked_host', reason: `Hostname '${host}' is blocked.`};
  }

  // Check userinfo/host confusion and empty host (e.g. "http:///").
  if (!host) {
    return {ok: false, reasonCode: 'blocked_host', reason: 'URL has no hostname.'};
  }

  // If the host is a literal IP, check ranges directly (no DNS needed).
  // No resolvedAddresses: literal IPs carry no DNS-rebinding surface, so the
  // caller can connect to the URL as-is without pinning.
  if (hostLooksLikeIp(host)) {
    if (isBlockedIp(host)) {
      return {ok: false, reasonCode: 'blocked_address', reason: `Address '${host}' is private, loopback, link-local, or otherwise blocked.`};
    }
    return {ok: true, url};
  }

  // Hostname: resolve and reject if ANY resolved address is blocked.
  // This defeats DNS rebinding (public hostname pointing at an internal IP).
  const lookup = options?.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return {ok: false, reasonCode: 'blocked_host', reason: `Could not resolve hostname '${host}'.`};
  }
  if (addresses.length === 0) {
    return {ok: false, reasonCode: 'blocked_host', reason: `Hostname '${host}' did not resolve to any address.`};
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      return {ok: false, reasonCode: 'blocked_address', reason: `Hostname '${host}' resolves to blocked address '${address}'.`};
    }
  }

  // Surface the validated addresses so the caller can pin the connection to
  // one of them, closing the DNS-rebinding TOCTOU between this check and the
  // actual connect (a public hostname that later re-resolves to an internal IP).
  return {ok: true, url, resolvedAddresses: addresses};
}
