import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
const anchors = {
  index: ['main', 'hero-title', 'benchmark-title', 'faq-title'],
  quickstart: ['main', 'requirements', 'install', 'providers', 'model', 'first-task', 'next-steps'],
  commands: ['main', 'session', 'config', 'skills', 'cli', 'print'],
  tools: ['main', 'read', 'write', 'shell', 'network', 'agent', 'lsp', 'boundaries'],
  skills: ['main', 'create', 'anatomy', 'scope', 'invoke', 'recipes', 'manage', 'plugins'],
  workflows: ['main', 'sessions', 'fleet', 'images', 'context', 'processes', 'ci'],
};
const names = Object.keys(anchors);
const pages = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(`${name}.html`, output), 'utf8')])));

test('public pages preserve their metadata, established anchors, and working internal links', () => {
  for (const name of names) {
    const html = pages[name];
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<link rel="canonical" href="https:\/\//);
    for (const id of anchors[name]) assert.ok(html.includes(`id="${id}"`), `${name}: missing #${id}`);
    for (const [, destination, anchor] of html.matchAll(/href="(?:(index|quickstart|commands|tools|skills|workflows)\.html)?#([^"?]+)"/g)) {
      assert.ok(pages[destination || name].includes(`id="${anchor}"`), `${name}: broken link to ${destination || name}#${anchor}`);
    }
    if (name !== 'index') {
      for (const target of names.slice(1)) {
        assert.ok(html.includes(`href="${target}.html"`), `${name}: missing ${target} navigation`);
      }
    }
  }
});

test('code examples retain their literal braces and public artifacts exclude private reviews', async () => {
  const workflow = pages.workflows;
  // Astro component expressions must not consume literal syntax in examples.
  assert.match(workflow, /\$&#123;&#123; secrets\.OPENROUTER_API_KEY &#125;&#125;/);
  assert.match(workflow, /&#123; fetch-depth: 0 &#125;/);
  const sitemap = await readFile(new URL('sitemap.xml', output), 'utf8');
  for (const name of names.slice(1)) assert.ok(sitemap.includes(`/${name}.html`));
  assert.doesNotMatch(sitemap, /architecture-review|\.md/);
  assert.ok(!(await readdir(output)).some(name => name.endsWith('.md')));
  assert.match(await readFile(new URL('robots.txt', output), 'utf8'), /Sitemap: https:\/\//);
});
