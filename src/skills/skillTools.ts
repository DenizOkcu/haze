import {tool, type ToolSet} from 'ai';
import {z} from 'zod';
import type {SkillRegistry} from './types.js';

export function buildSkillTools(registry: SkillRegistry): ToolSet {
  if (registry.skills.size === 0) return {};
  const catalog = [...registry.skills.values()].map(skill => `${skill.name}: ${skill.description}`).join('\n');
  return {
    skill: tool({
      description: `Load one installed Markdown workflow by name. Available skills:\n${catalog}`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Exact skill name from the catalog'),
        reference: z.string().optional().describe('Optional referenced path to load after reading the skill instructions'),
      }),
      execute: async ({name, reference}: {name: string; reference?: string}) => {
        const skill = registry.skills.get(name);
        if (!skill) return {ok: false, error: `Unknown skill: ${name}`, available: [...registry.skills.keys()]};
        if (reference) {
          const selected = skill.references.find(item => item.path === reference);
          return selected
            ? {ok: true, name: skill.name, reference: {path: selected.path, content: selected.content}}
            : {ok: false, error: `Unknown reference for ${name}: ${reference}`, availableReferences: skill.references.map(item => item.path)};
        }
        return {
          ok: true,
          name: skill.name,
          description: skill.description,
          instructions: skill.body,
          references: skill.references.map(item => item.path),
        };
      },
    }),
  };
}
