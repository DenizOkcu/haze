export function GET() {
  const root = new URL(import.meta.env.SITE);
  const pages = ['./', 'quickstart.html', 'commands.html', 'tools.html', 'skills.html', 'workflows.html'];
  const urls = pages.map(page => `  <url><loc>${new URL(page, root).href.replaceAll('&', '&amp;')}</loc></url>`).join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
}
