import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Explicit allowlist: never copy source, private Markdown, or arbitrary build files.
const files = ['index.html', 'quickstart.html', 'commands.html', 'tools.html', 'skills.html', 'workflows.html', 'site.css', 'site.js', 'home.css', 'home.js', 'robots.txt', 'sitemap.xml'];
const checking = process.argv.includes('--check');
let stale = false;
for (const file of files) {
  const built = await readFile(new URL(`../dist/${file}`, import.meta.url));
  const target = new URL(`../../docs/${file}`, import.meta.url);
  if (checking) {
    const existing = await readFile(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!existing || !built.equals(existing)) {
      console.error(`Generated file is out of date: ${fileURLToPath(target)}`);
      stale = true;
    }
  } else {
    await writeFile(target, built);
    console.log(`Updated docs/${file}`);
  }
}
if (stale) {
  console.error('Run npm run sync --prefix website and commit the generated files.');
  process.exitCode = 1;
}
