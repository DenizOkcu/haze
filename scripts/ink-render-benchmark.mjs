// Run: node --expose-gc scripts/ink-render-benchmark.mjs <installation-root> [samples]
// Same synthetic renderer workload on v7/v8; no application settings or home reads.
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {PassThrough, Writable} from 'node:stream';
import {performance} from 'node:perf_hooks';

const root = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(root, 'package.json'));
const React = require('react');
const ink = await import(pathToFileURL(require.resolve('ink')).href);
const {Box, Static, Text, render} = ink;
const el = React.createElement;
const history = Array.from({length: 1000}, (_, index) => `benchmark-record-${index} 界🙂`);
class Output extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  bytes = 0;
  writes = 0;
  text = '';
  _write(chunk, _encoding, callback) {
    this.bytes += chunk.length;
    this.writes += 1;
    this.text += String(chunk);
    callback();
  }
}
function tree(tick) {
  return el(Box, {flexDirection: 'column'},
    el(Static, {items: history}, text => el(Text, {key: text}, text)),
    el(Text, {}, Array.from({length: 4}, (_, row) => `tail-${tick}-${row} 界🙂`).join('\n')));
}
const samples = [];
for (let sample = 0; sample < Number(process.argv[3] ?? 3) + 1; sample++) {
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage().heapUsed;
  const stdin = new PassThrough();
  const stdout = new Output();
  const stderr = new PassThrough();
  const start = performance.now();
  let frames = 0;
  let app = render(tree(0), {stdin, stdout, stderr, patchConsole: false, interactive: true,
    incrementalRendering: true, maxFps: 15, exitOnCtrlC: false, onRender: () => { frames += 1; }});
  try {
    await app.waitUntilRenderFlush();
    for (let tick = 1; tick <= 60; tick++) {
      if (tick % 15 === 0) {
        stdout.columns = stdout.columns === 80 ? 40 : 80;
        stdout.rows = stdout.rows === 24 ? 12 : 24;
        stdout.emit('resize');
      }
      app.rerender(tree(tick));
      await app.waitUntilRenderFlush();
    }
    app.unmount();
    await app.waitUntilExit();
    assert.equal(stdout.text.match(/benchmark-record-999/g)?.length, 1);
    assert.ok(!stdout.text.includes('\x1b[3J'));
    assert.ok(stdout.text.includes('tail-60-'));
    if (sample > 0) samples.push({bytes: stdout.bytes, writes: stdout.writes, frames,
      elapsedMs: Math.round(performance.now() - start), heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore});
  } finally {
    app.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy();
    app = undefined;
  }
  await new Promise(resolve => setImmediate(resolve));
  globalThis.gc?.();
  if (sample > 0) samples.at(-1).retainedHeapDeltaBytes = process.memoryUsage().heapUsed - memoryBefore;
}
console.log(JSON.stringify({node: process.version, installation: root, samples}, null, 2));
