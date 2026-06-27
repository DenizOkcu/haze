export interface ExternalContentOptions {
  type: 'webpage' | 'mcp-tool';
  origin?: string;
  server?: string;
}

function escapeExternalContent(content: string): string {
  return content.replaceAll('</external-content>', '<\\/external-content>');
}

export function wrapExternalContent(content: string, options: ExternalContentOptions): string {
  const {type, origin, server} = options;
  const attrs = [`type="${type}"`];
  if (origin) attrs.push(`origin="${origin}"`);
  if (server) attrs.push(`server="${server}"`);
  return `<external-content ${attrs.join(' ')}>
${escapeExternalContent(content)}
</external-content>`;
}
