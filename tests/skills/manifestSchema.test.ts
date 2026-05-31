import {describe, it, expect} from 'vitest';
import {skillManifestSchema} from '../../src/skills/manifestSchema.js';

describe('skillManifestSchema', () => {
  it('parses a minimal valid manifest', () => {
    const result = skillManifestSchema.safeParse({
      name: 'my-skill',
      version: '1.0.0',
      description: 'A test skill',
    });
    expect(result.success).toBe(true);
  });

  it('parses a full valid manifest', () => {
    const result = skillManifestSchema.safeParse({
      name: 'my-skill',
      version: '2.0.0',
      description: 'A test skill',
      author: 'Test Author',
      homepage: 'https://example.com',
      dependencies: {
        cli: [{name: 'node', required: true}],
        env: [{name: 'API_KEY', description: 'Key'}],
      },
      tools: [{
        name: 'run',
        description: 'Runs the tool',
        path: 'tools/run.ts',
      }],
      prompts: [{
        name: 'planning',
        path: 'prompts/plan.md',
      }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my-skill');
      expect(result.data.tools).toHaveLength(1);
      expect(result.data.prompts).toHaveLength(1);
    }
  });

  it('rejects empty name', () => {
    const result = skillManifestSchema.safeParse({
      name: '',
      version: '1.0.0',
      description: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name with special characters', () => {
    const result = skillManifestSchema.safeParse({
      name: 'my skill!',
      version: '1.0.0',
      description: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('allows hyphens and underscores in name', () => {
    const result = skillManifestSchema.safeParse({
      name: 'my_skill-123',
      version: '1.0.0',
      description: 'test',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty version', () => {
    const result = skillManifestSchema.safeParse({
      name: 'skill',
      version: '',
      description: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty description', () => {
    const result = skillManifestSchema.safeParse({
      name: 'skill',
      version: '1.0.0',
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid homepage url', () => {
    const result = skillManifestSchema.safeParse({
      name: 'skill',
      version: '1.0.0',
      description: 'test',
      homepage: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('allows optional fields to be omitted', () => {
    const result = skillManifestSchema.safeParse({
      name: 'skill',
      version: '1.0.0',
      description: 'Minimal skill',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBeUndefined();
      expect(result.data.homepage).toBeUndefined();
      expect(result.data.dependencies).toBeUndefined();
      expect(result.data.tools).toBeUndefined();
      expect(result.data.prompts).toBeUndefined();
    }
  });

  it('parses tool with input schema', () => {
    const result = skillManifestSchema.safeParse({
      name: 'skill',
      version: '1.0.0',
      description: 'test',
      tools: [{
        name: 'search',
        description: 'Searches',
        path: 'tools/search.ts',
        input: {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'Search query'},
          },
        },
      }],
    });
    expect(result.success).toBe(true);
  });
});
