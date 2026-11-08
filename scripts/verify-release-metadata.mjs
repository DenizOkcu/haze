#!/usr/bin/env node
// Read-only release-metadata consistency check (RH-011). Derives the package
// version and validates that the lockfile root, README, changelog, SECURITY
// supported series, and static docs all agree. Reports every
// mismatch in one run and exits non-zero. Does not rewrite any file.
//
// Usage: node scripts/verify-release-metadata.mjs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// fileURLToPath (not URL.pathname): URL-decodes percent escapes and handles
// Windows drive letters, so checkouts under paths with spaces/#/non-ASCII
// resolve to the real filesystem root (MR-04).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function read(file) {
  try {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function minorSeries(version) {
  const match = /^(\d+\.\d+)\.\d+/.exec(version);
  return match ? `${match[1]}.x` : undefined;
}

const pkg = JSON.parse(read('package.json') ?? '{}');
const version = pkg.version;
if (!version) {
  problems.push('package.json: missing "version" field.');
  process.exit(1);
}
const series = minorSeries(version);
if (!series) {
  problems.push(`package.json: cannot derive minor series from version "${version}".`);
}

// 1. Lockfile root version must match the package version.
const lockfile = JSON.parse(read('package-lock.json') ?? '{}');
const lockVersion = lockfile?.packages?.['']?.version ?? lockfile?.version;
if (lockVersion !== version) {
  problems.push(`package-lock.json: root version "${lockVersion}" does not match package.json "${version}".`);
}

// 2. README must reference the version (badge/heading/support note).
const readme = read('README.md');
if (readme && !readme.includes(version)) {
  problems.push(`README.md: does not reference version "${version}".`);
}

// 3. CHANGELOG must have a release heading for the version.
const changelog = read('CHANGELOG.md');
if (changelog && !new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|-|$)`, 'm').test(changelog)) {
  problems.push(`CHANGELOG.md: missing "## ${version}" release heading.`);
}

// 4. SECURITY policy must list the current minor series as supported.
const security = read('SECURITY.md');
if (security && series && !security.includes(series)) {
  problems.push(`SECURITY.md: supported-series table does not mention "${series}" (derived from ${version}).`);
}

// 5. Static docs pages must carry the current version stamp.
const docsDir = path.join(repoRoot, 'docs');
if (fs.existsSync(docsDir) && series) {
  for (const file of fs.readdirSync(docsDir)) {
    if (!file.endsWith('.html')) continue;
    const content = read(`docs/${file}`);
    if (content && !content.includes(version)) {
      problems.push(`docs/${file}: does not reference version "${version}".`);
    }
  }
}

// 6. Packed buildInfo must not leak the publisher's filesystem (SC-7). The
// build step runs before this check in `prepublishOnly`, so dist/ exists at
// publish time; when it does not (e.g. release:verify on a fresh checkout in
// CI, which runs before `npm run build`), the check is skipped like the other
// file-optional checks above.
const buildInfoRaw = read('dist/buildInfo.json');
if (buildInfoRaw !== undefined) {
  if (buildInfoRaw.includes('/Users/') || buildInfoRaw.includes('/home/')) {
    problems.push('dist/buildInfo.json: contains an absolute home-directory path (expected no /Users/ or /home/ string; sourceRoot must not ship).');
  }
  let buildInfo;
  try {
    buildInfo = JSON.parse(buildInfoRaw);
  } catch {
    buildInfo = undefined;
  }
  if (!buildInfo || typeof buildInfo !== 'object') {
    problems.push('dist/buildInfo.json: not valid JSON.');
  } else if (buildInfo.sourceRoot != null && buildInfo.sourceRoot !== '') {
    problems.push('dist/buildInfo.json: "sourceRoot" must be empty or omitted.');
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\n${problems.length} release-metadata mismatch(es) for version ${version}.`);
  process.exit(1);
}

console.log(`Release metadata consistent at version ${version}${series ? ` (${series})` : ''}.`);
