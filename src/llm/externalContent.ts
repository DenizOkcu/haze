export interface ExternalContentOptions {
  type: 'webpage' | 'mcp-tool';
  origin?: string;
  server?: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function escapeExternalContent(content: string): string {
  return content
    .replaceAll(/<\/external-content>/gi, '<\\/external-content>')
    .replaceAll(/<external-content/gi, '<\\external-content');
}

export function wrapExternalContent(content: string, options: ExternalContentOptions): string {
  const {type, origin, server} = options;
  const attrs = [`type="${type}"`];
  if (origin) attrs.push(`origin="${escapeHtml(origin)}"`);
  if (server) attrs.push(`server="${escapeHtml(server)}"`);
  return `<external-content ${attrs.join(' ')}>
${escapeExternalContent(content)}
</external-content>`;
}
