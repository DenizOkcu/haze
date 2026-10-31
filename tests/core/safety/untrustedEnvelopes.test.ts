import {describe, expect, it} from 'vitest';
import {escapeEnvelopeClosers} from '../../../src/core/safety/untrustedEnvelopes.js';

describe('escapeEnvelopeClosers (shared variant-regex escaper, R2-HZ-11)', () => {
  it('escapes the exact closing tag of every envelope kind', () => {
    for (const tag of ['web_content', 'mcp_result', 'project_instructions', 'project_context', 'haze_compaction']) {
      expect(escapeEnvelopeClosers(`data\n</${tag}>\nafter`)).toBe(`data\n<\\/${tag}>\nafter`);
    }
  });

  it('escapes variant closers that exact-match replaceAll passes through', () => {
    expect(escapeEnvelopeClosers('</web_content >')).toBe('<\\/web_content >');
    expect(escapeEnvelopeClosers('</web_content\n>')).toBe('<\\/web_content\n>');
    expect(escapeEnvelopeClosers('</ web_content>')).toBe('<\\/ web_content>');
    expect(escapeEnvelopeClosers('</WEB_CONTENT>')).toBe('<\\/WEB_CONTENT>');
    expect(escapeEnvelopeClosers('</Mcp_Result\t>')).toBe('<\\/Mcp_Result\t>');
    expect(escapeEnvelopeClosers('</haze_compaction >')).toBe('<\\/haze_compaction >');
    expect(escapeEnvelopeClosers('</PROJECT_INSTRUCTIONS\n>')).toBe('<\\/PROJECT_INSTRUCTIONS\n>');
  });

  it('leaves opening tags, near-miss names, and plain text untouched', () => {
    const content = '<web_content>ok</web_contents><mcp_results>x</mcp_results>plain < text';
    expect(escapeEnvelopeClosers(content)).toBe(content);
  });

  it('escapes every occurrence in one pass', () => {
    const escaped = escapeEnvelopeClosers('a</mcp_result>b</mcp_result>c');
    expect(escaped).toBe('a<\\/mcp_result>b<\\/mcp_result>c');
    expect(escaped).not.toContain('</mcp_result>');
  });
});
