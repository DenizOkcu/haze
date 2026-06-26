#!/usr/bin/env node
// Compares V8 (Istanbul) coverage-final.json between a PR's base and head.
// Fails the CI step if head coverage is lower than base coverage, enforcing
// "test coverage must never decrease on a PR".
//
// Usage: node compare-coverage.mjs <base-coverage-final.json> <head-coverage-final.json>
//
// Gates on statements and branches (weighted aggregates across all files).
// Functions are intentionally skipped: the v8 provider reports unreliable
// per-function hit counts (count is 0 for called functions), so it is a poor
// regression signal. Statements and branches are stable.
//
// A small epsilon (0.01%) absorbs float rounding noise; only a real drop
// (i.e. fewer hits or more uncovered items) trips the gate.

import fs from 'node:fs';

const [basePath, headPath] = process.argv.slice(2);
const EPSILON = 0.01;

if (!basePath || !headPath) {
  console.error('Usage: compare-coverage.mjs <base.json> <head.json>');
  process.exit(2);
}

function aggregate(filePath) {
  const cov = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let st = 0, sc = 0, bt = 0, bc = 0;
  for (const file of Object.keys(cov)) {
    const d = cov[file];
    for (const k of Object.keys(d.s ?? {})) {
      st++;
      if (d.s[k] > 0) sc++;
    }
    for (const k of Object.keys(d.b ?? {})) {
      for (const v of d.b[k]) {
        bt++;
        if (v > 0) bc++;
      }
    }
  }
  const pct = (c, t) => (t === 0 ? 100 : (100 * c) / t);
  return {
    statements: {covered: sc, total: st, pct: pct(sc, st)},
    branches: {covered: bc, total: bt, pct: pct(bc, bt)},
  };
}

let base, head;
try {
  base = aggregate(basePath);
  head = aggregate(headPath);
} catch (err) {
  console.error(`Failed to read coverage reports: ${err.message}`);
  process.exit(2);
}

const fmt = (m) => `${m.pct.toFixed(2)}% (${m.covered}/${m.total})`;

console.log('Coverage comparison (base → head):');
console.log(`  statements: ${fmt(base.statements)} → ${fmt(head.statements)}`);
console.log(`  branches:    ${fmt(base.branches)} → ${fmt(head.branches)}`);

const regressions = [];
for (const metric of ['statements', 'branches']) {
  const drop = base[metric].pct - head[metric].pct;
  if (drop > EPSILON) {
    regressions.push(
      `${metric} decreased ${drop.toFixed(2)}% (${base[metric].pct.toFixed(2)}% → ${head[metric].pct.toFixed(2)}%)`,
    );
  }
}

if (regressions.length > 0) {
  console.error('\n::error::Coverage regression detected — test coverage must not decrease on a PR.');
  for (const r of regressions) console.error(`::error::${r}`);
  console.error('\nAdd or restore tests for the changed/uncovered code, then re-run.');
  process.exit(1);
}

console.log('\nNo coverage regression. OK.');