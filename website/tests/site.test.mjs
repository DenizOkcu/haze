import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
const names = ['index', 'quickstart', 'commands', 'tools', 'skills', 'workflows'];
const pages = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(`${name}.html`, output), 'utf8')])));

test('each public page has metadata and retains its authored anchors and links', async () => {
  for (const name of names) {
    const html = pages[name];
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<link rel="canonical" href="https:\/\//);
    const fragment = await readFile(new URL(`../src/content/${name}.html`, import.meta.url), 'utf8');
    for (const [, id] of fragment.matchAll(/\bid="([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), `${name}: missing #${id}`);
    for (const [, href] of fragment.matchAll(/\bhref="([^"]+)"/g)) assert.ok(html.includes(`href="${href}"`), `${name}: missing ${href}`);
    for (const [, destination, anchor] of html.matchAll(/href="(?:(index|quickstart|commands|tools|skills|workflows)\.html)?#([^"?]+)"/g)) {
      assert.ok(pages[destination || name].includes(`id="${anchor}"`), `${name}: broken link to ${destination || name}#${anchor}`);
    }
  }
});

test('sitemap lists only public page URLs and build excludes private reviews', async () => {
  const sitemap = await readFile(new URL('sitemap.xml', output), 'utf8');
  for (const name of names.slice(1)) assert.ok(sitemap.includes(`/${name}.html`));
  assert.doesNotMatch(sitemap, /architecture-review|\.md/);
  assert.ok(!(await readdir(output)).some(name => name.endsWith('.md')));
  assert.match(await readFile(new URL('robots.txt', output), 'utf8'), /Sitemap: https:\/\//);
});
