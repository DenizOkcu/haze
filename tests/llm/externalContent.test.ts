import {describe, it, expect} from 'vitest';
import {wrapExternalContent} from '../../src/llm/externalContent.js';

describe('wrapExternalContent', () => {
  it('wraps content with type and origin attributes', () => {
    const result = wrapExternalContent('hello', {type: 'webpage', origin: 'https://example.com'});
    expect(result).toContain('<external-content type="webpage" origin="https://example.com">');
    expect(result).toContain('hello');
    expect(result).toContain('</external-content>');
  });

  it('wraps content with type and server attributes', () => {
    const result = wrapExternalContent('result', {type: 'mcp-tool', server: 'ctx7'});
    expect(result).toContain('<external-content type="mcp-tool" server="ctx7">');
    expect(result).toContain('result');
    expect(result).toContain('</external-content>');
  });

  it('escapes closing external-content tags inside content', () => {
    const result = wrapExternalContent('a</external-content>b', {type: 'webpage', origin: 'https://x.com'});
    expect(result).toContain('<\\/external-content>');
    expect(result).not.toContain('a</external-content>b');
  });

  it('escapes case variants of external-content tags', () => {
    const result = wrapExternalContent('a</External-Content>b<external-Content>c', {type: 'webpage', origin: 'https://x.com'});
    expect(result).toContain('<\\/external-content>');
    expect(result).toContain('<\\external-content');
    expect(result).not.toContain('</External-Content>');
    expect(result).not.toContain('<external-Content>');
  });

  it('escapes attribute-breaking characters in origin and server', () => {
    const result = wrapExternalContent('x', {type: 'webpage', origin: 'https://x.com?a="b"&c=<d>'});
    expect(result).toContain('origin="https://x.com?a=&quot;b&quot;&amp;c=&lt;d&gt;"');
    const serverResult = wrapExternalContent('x', {type: 'mcp-tool', server: 'ctx<7>&"foo"'});
    expect(serverResult).toContain('server="ctx&lt;7&gt;&amp;&quot;foo&quot;"');
  });

  it('wraps empty content', () => {
    const result = wrapExternalContent('', {type: 'webpage', origin: 'https://x.com'});
    expect(result).toContain('<external-content type="webpage" origin="https://x.com">');
    expect(result).toContain('</external-content>');
  });
});
