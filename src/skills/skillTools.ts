import {tool} from 'ai';
import {z} from 'zod';
import type {SkillRegistry} from './types.js';

function toolNameForSkill(name: string) {
  return `skill_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function buildSkillTools(registry: SkillRegistry) {
  const entries = [...registry.skills.values()].map(skill => [toolNameForSkill(skill.name), tool({
    description: skill.description,
    inputSchema: z.object({
      reason: z.string().optional().describe('Why this skill is relevant to the current task'),
    }),
    execute: async ({reason}: {reason?: string}) => ({
      name: skill.name,
      description: skill.description,
      reason,
      instructions: skill.body,
      references: skill.references.map(reference => ({
        path: reference.path,
        content: reference.content,
      })),
    }),
  })] as const);
  return Object.fromEntries(entries);
}

export const internals = {toolNameForSkill};
