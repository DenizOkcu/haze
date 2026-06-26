import {describe, expect, it} from 'vitest';
import {addCapabilityTools} from '../../src/llm/capabilities.js';

function toolSet(entries: Record<string, {description: string}>) {
  return Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, value]));
}

describe('addCapabilityTools', () => {
  it('copies tools from a single loaded capability into the available set', () => {
    const available: Record<string, unknown> = {};
    const categories = new Map<string, string>();
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'builtin', tools: toolSet({foo: {description: 'foo'}, bar: {description: 'bar'}})},
    });
    expect(Object.keys(available).sort()).toEqual(['bar', 'foo']);
    expect(categories.get('foo')).toBe('builtin');
    expect(categories.get('bar')).toBe('builtin');
  });

  it('tracks the originating category per tool when merging multiple capabilities', () => {
    const available: Record<string, unknown> = {};
    const categories = new Map<string, string>();
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'builtin', tools: toolSet({readFile: {description: 'r'}})},
    });
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'mcp', tools: toolSet({customTool: {description: 'c'}})},
    });
    expect(categories.get('readFile')).toBe('builtin');
    expect(categories.get('customTool')).toBe('mcp');
  });

  it('overwrites an existing tool and re-categorizes it when skipCollisions is false', () => {
    const available: Record<string, unknown> = {readFile: {description: 'old'}};
    const categories = new Map<string, string>([['readFile', 'builtin']]);
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'mcp', tools: toolSet({readFile: {description: 'new'}})},
    });
    expect((available.readFile as {description: string}).description).toBe('new');
    expect(categories.get('readFile')).toBe('mcp');
  });

  it('keeps the original tool and category when skipCollisions is true and a name clashes', () => {
    const original = {description: 'kept'};
    const available: Record<string, unknown> = {readFile: original};
    const categories = new Map<string, string>([['readFile', 'builtin']]);
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'mcp', tools: toolSet({readFile: {description: 'ignored'}})},
      skipCollisions: true,
    });
    expect(available.readFile).toBe(original);
    expect(categories.get('readFile')).toBe('builtin');
  });

  it('does not record a category for tools skipped due to a collision', () => {
    const available: Record<string, unknown> = {shared: {description: 'first'}};
    const categories = new Map<string, string>([['shared', 'builtin']]);
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'skill', tools: toolSet({shared: {description: 'second'}, fresh: {description: 'fresh'}})},
      skipCollisions: true,
    });
    expect(categories.get('shared')).toBe('builtin');
    expect(categories.get('fresh')).toBe('skill');
  });

  it('treats an empty loaded capability as a no-op', () => {
    const available: Record<string, unknown> = {existing: {description: 'x'}};
    const categories = new Map<string, string>([['existing', 'builtin']]);
    addCapabilityTools({
      availableTools: available,
      toolCategories: categories,
      loaded: {category: 'mcp', tools: {}},
    });
    expect(Object.keys(available)).toEqual(['existing']);
    expect(categories.size).toBe(1);
  });
});
