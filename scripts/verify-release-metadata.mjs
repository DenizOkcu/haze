#!/usr/bin/env node
// Read-only release-metadata consistency check (RH-011). Derives the package
// version and validates that the lockfile root, README, changelog, SECURITY
// supported series, static docs, and AGENTS stamps all agree. Reports every
// mismatch in one run and exits non-zero. Does not rewrite any file.
//
// Usage: node scripts/verify-release-metadata.mjs
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
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

// 6. AGENTS.md stamps must target the current release.
const agentsStamp = new RegExp(`for the ${version.replace(/\./g, '\\.')} release`);
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name === 'AGENTS.md') yield full;
  }
}
if (fs.existsSync(path.join(repoRoot, 'src'))) {
  let checked = 0;
  for (const file of walk(repoRoot)) {
    const content = read(path.relative(repoRoot, file));
    if (content && content.includes('Last updated:') && !agentsStamp.test(content)) {
      problems.push(`${path.relative(repoRoot, file)}: stamp does not target release ${version}.`);
    }
    if (content && content.includes('Last updated:')) checked++;
  }
  if (checked === 0) {
    problems.push('No AGENTS.md "Last updated:" stamps found to verify.');
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\n${problems.length} release-metadata mismatch(es) for version ${version}.`);
  process.exit(1);
}

console.log(`Release metadata consistent at version ${version}${series ? ` (${series})` : ''}.`);
