import {describe, expect, it} from 'vitest';
import {buildLspTools} from '../../src/llm/lspTools.js';
import {groupsForRequest, toolGroup} from '../../src/llm/toolGroups.js';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('tool groups', () => {
  it('classifies built-in tools by exact name, never by prefix', () => {
    expect(toolGroup('gitStatus')).toBe('git-read');
    expect(toolGroup('gitReset')).toBe('git-write');
    expect(toolGroup('graphQuery')).toBe('graph');
    expect(toolGroup('lspDefinition')).toBe('lsp');
    // MCP tools with a built-in prefix are not members of any group.
    expect(toolGroup('lspLint')).toBeUndefined();
    expect(toolGroup('graphQL')).toBeUndefined();
    expect(toolGroup('gitHub')).toBeUndefined();
    expect(toolGroup('toString')).toBeUndefined();
  });

  it('keeps the group table in step with the built-in catalogs', () => {
    const grouped = Object.keys(hazeTools).filter(name => /^(git|graph|lsp)[A-Z]/.test(name));
    for (const name of grouped) expect(toolGroup(name), name).toBeDefined();
    for (const name of Object.keys(buildLspTools())) expect(toolGroup(name), name).toBe('lsp');
  });

  it('seeds groups only for requests that clearly need them', () => {
    expect(groupsForRequest('where is the config map?')).toEqual(new Set());
    expect(groupsForRequest('git clone the repository layout for the test')).toEqual(new Set(['git-read', 'git-network']));
    expect(groupsForRequest('please git clone the repo')).toEqual(new Set(['git-read', 'git-network']));
    expect(groupsForRequest('rename the helper everywhere')).toEqual(new Set(['lsp']));
    expect(groupsForRequest('explain the architecture')).toEqual(new Set(['graph']));
  });
});
