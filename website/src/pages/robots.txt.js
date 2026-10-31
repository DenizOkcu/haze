export function GET() {
  const sitemap = new URL('sitemap.xml', import.meta.env.SITE).href;
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`);
}
