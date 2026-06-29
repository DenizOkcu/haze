import {describe, it, expect} from 'vitest';
import {compareVersions, formatVersion, isNewer, parseVersion} from '../../src/utils/version.js';

describe('parseVersion', () => {
  it('parses a simple release', () => {
    expect(parseVersion('0.6.0')).toEqual({release: [0, 6, 0], prerelease: []});
  });

  it('strips a leading v', () => {
    expect(parseVersion('v1.2.3')).toEqual({release: [1, 2, 3], prerelease: []});
  });

  it('parses a pre-release suffix', () => {
    expect(parseVersion('1.0.0-beta.1')).toEqual({release: [1, 0, 0], prerelease: ['beta', '1']});
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.0.0+sha')).toEqual({release: [1, 0, 0], prerelease: []});
  });

  it('treats malformed input as 0.0.0', () => {
    expect(parseVersion('not-a-version')).toEqual({release: [0, 0, 0], prerelease: []});
  });

  it('pads missing segments with zero', () => {
    expect(parseVersion('1')).toEqual({release: [1, 0, 0], prerelease: []});
  });
});

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
  });

  it('compares major versions', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
  });

  it('compares minor versions', () => {
    expect(compareVersions('0.7.0', '0.6.9')).toBe(1);
  });

  it('compares patch versions', () => {
    expect(compareVersions('0.6.1', '0.6.0')).toBe(1);
  });

  it('handles leading v prefixes on either side', () => {
    expect(compareVersions('v0.6.0', '0.6.0')).toBe(0);
    expect(compareVersions('v0.7.0', '0.6.0')).toBe(1);
  });

  it('treats a release as newer than its prerelease', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  it('orders numeric pre-release segments numerically', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
  });

  it('treats malformed input as 0.0.0', () => {
    expect(compareVersions('garbage', '0.0.0')).toBe(0);
  });
});

describe('isNewer', () => {
  it('is true when latest is strictly newer', () => {
    expect(isNewer('0.7.0', '0.6.0')).toBe(true);
    expect(isNewer('0.6.1', '0.6.0')).toBe(true);
  });

  it('is false when equal', () => {
    expect(isNewer('0.6.0', '0.6.0')).toBe(false);
  });

  it('is false when latest is older', () => {
    expect(isNewer('0.5.9', '0.6.0')).toBe(false);
  });

  it('is false when latest is a prerelease of the current release', () => {
    expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false);
  });
});

describe('formatVersion', () => {
  it('decorates with a short commit for dev/local builds', () => {
    expect(formatVersion('0.6.0', 'e5c03c0')).toBe('0.6.0@e5c03c0');
  });

  it('returns the plain version when there is no commit', () => {
    expect(formatVersion('0.6.0')).toBe('0.6.0');
    expect(formatVersion('0.6.0', undefined)).toBe('0.6.0');
  });

  it('ignores an empty commit string', () => {
    expect(formatVersion('0.6.0', '')).toBe('0.6.0');
  });
});
