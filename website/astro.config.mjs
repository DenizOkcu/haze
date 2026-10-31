import { defineConfig } from 'astro/config';

const site = process.env.PUBLIC_SITE_URL || 'https://denizokcu.github.io/haze/';
export default defineConfig({ site, outDir: process.env.PUBLIC_SITE_OUT_DIR || './dist', output: 'static', build: { format: 'file' } });
