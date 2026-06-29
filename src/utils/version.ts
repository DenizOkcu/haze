/**
 * Minimal, dependency-free version comparison for the update check.
 *
 * Handles npm package versions like `0.6.0`, `1.2.3`, with optional leading
 * `v` and optional pre-release suffix (`1.0.0-beta.1`). Numeric release
 * segments are compared numerically; pre-release sorts *below* its release
 * (so `1.0.0-beta.1` is older than `1.0.0`). Malformed input is treated as
 * `0.0.0` so the check degrades to "no update" rather than throwing.
 *
 * Kept small on purpose: no `semver` dependency for a single comparison.
 */
export interface ParsedVersion {
  release: [number, number, number];
  prerelease: string[];
}

export function parseVersion(input: string): ParsedVersion {
  const cleaned = input.trim().replace(/^v/i, '');
  // Drop build metadata: everything from the first '+' onward is ignored.
  const withoutBuild = cleaned.split('+')[0] ?? '';
  // Pre-release is denoted by the first '-' after the release identifier.
  const dashIndex = withoutBuild.indexOf('-');
  const releasePart = dashIndex >= 0 ? withoutBuild.slice(0, dashIndex) : withoutBuild;
  // No numeric release segment => treat the whole input as 0.0.0 (no pre-release).
  if (!/\d/.test(releasePart)) return {release: [0, 0, 0], prerelease: []};
  const segments = releasePart.split('.');
  const nums: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    const parsed = Number.parseInt((segments[index] ?? '').replace(/[^0-9]/g, ''), 10);
    nums[index] = Number.isFinite(parsed) ? parsed : 0;
  }
  const prereleasePart = dashIndex >= 0 ? withoutBuild.slice(dashIndex + 1) : '';
  const prerelease = prereleasePart ? prereleasePart.split('.').map(part => part.trim()).filter(Boolean) : [];
  return {release: nums, prerelease};
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease suffix means "higher" than any prerelease; handled by caller.
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index++) {
    if (index >= a.length) return -1; // a is shorter → a is older
    if (index >= b.length) return 1;
    const aa = a[index]!;
    const bb = b[index]!;
    const anum = Number(aa);
    const bnum = Number(bb);
    const bothNumeric = Number.isFinite(anum) && Number.isFinite(bnum);
    if (bothNumeric) {
      if (anum < bnum) return -1;
      if (anum > bnum) return 1;
    } else {
      if (aa < bb) return -1;
      if (aa > bb) return 1;
    }
  }
  return 0;
}

/** Returns -1 if `a` is older than `b`, 0 if equal, 1 if `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let index = 0; index < 3; index++) {
    if (pa.release[index]! < pb.release[index]!) return -1;
    if (pa.release[index]! > pb.release[index]!) return 1;
  }
  const aHasPre = pa.prerelease.length > 0;
  const bHasPre = pb.prerelease.length > 0;
  if (!aHasPre && bHasPre) return 1; // release is newer than prerelease
  if (aHasPre && !bHasPre) return -1;
  if (aHasPre && bHasPre) return comparePrerelease(pa.prerelease, pb.prerelease);
  return 0;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * Decorate a release version with a short commit for dev/local builds
 * (e.g. `0.6.0` → `0.6.0@e5c03c0`). Published builds pass no commit and get the
 * plain version back. Trivial and pure so it is unit-testable in isolation.
 *
 * Note: the `@`-decorated form is for human display only — it is NOT valid semver
 * and must not reach `isNewer`/`parseVersion` (they would mis-parse it). Callers keep
 * the base version for the update check.
 */
export function formatVersion(base: string, commit?: string): string {
  return commit ? `${base}@${commit}` : base;
}
