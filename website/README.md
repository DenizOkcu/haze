# Public site

This Astro project generates the homepage and documentation. Edit page content
and metadata in `src/content/`, shared navigation and metadata in
`src/layouts/`, and browser assets in `public/`. Content files are trusted
repository-authored HTML fragments, rendered by the shared Astro layout.

```sh
npm ci --prefix website
npm run sync --prefix website
npm run check --prefix website
node --test website/tests/*.test.mjs
```

Commit the generated `docs/` files for GitHub Pages. The sync script uses an
allowlist and does not remove or publish the internal Markdown in `docs/`.
The public site is independent from the CLI package; use Node 24 or later for
its build. `PUBLIC_SITE_URL` overrides the canonical site URL (including a
trailing slash), and `PUBLIC_SITE_OUT_DIR` selects a separate build directory.
