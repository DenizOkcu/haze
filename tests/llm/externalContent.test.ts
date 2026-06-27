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
});
