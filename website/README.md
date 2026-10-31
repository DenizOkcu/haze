# Public site

This Astro project generates the homepage and documentation. Edit page content and metadata in `src/pages/*.astro`, the shared documentation
layout and navigation in `src/components/DocPage.astro`, the site shell in
`src/layouts/`, and browser assets in `public/`. Documentation page outlines
are defined by their `toc` arrays. Escape literal braces in examples as
`&#123;` and `&#125;` so Astro renders them as text.

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
