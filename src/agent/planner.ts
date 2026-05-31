import {generateObject} from 'ai';
import {z} from 'zod';
import {model} from '../llm/client.js';
import type {SkillRegistry} from '../skills/SkillRegistry.js';
import type {AgentPlan} from './types.js';

const planSchema = z.object({
  summary: z.string(),
  requiresTools: z.boolean(),
  needsApproval: z.boolean(),
  steps: z.array(z.object({
    description: z.string(),
    tool: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional()
  }))
});

export async function createPlan(request: string, registry: SkillRegistry): Promise<AgentPlan> {
  const m = model();
  if (!m) return heuristicPlan(request, registry);
  const tools = [...registry.tools.values()].map(t => ({name: t.id, description: t.description, input: t.input ?? {type: 'object'}}));
  const {object} = await generateObject({
    model: m,
    schema: planSchema,
    system: `You are Haze, a pragmatic CLI agent. Create a small, safe plan using only listed tools. Every tool execution needs approval. Do not invent tools. Available skill prompts:\n${registry.getPromptContext()}`,
    prompt: `User request: ${request}\n\nAvailable tools:\n${JSON.stringify(tools, null, 2)}`
  });
  return object;
}

function heuristicPlan(request: string, registry: SkillRegistry): AgentPlan {
  const lower = request.toLowerCase();
  const steps = [] as AgentPlan['steps'];
  if ((lower.includes('list') || lower.includes('files')) && registry.tools.has('files.list_files')) {
    steps.push({description: 'List files in the current project.', tool: 'files.list_files', input: {dir: '.'}});
  }
  if ((lower.includes('read') || lower.includes('package.json')) && registry.tools.has('files.read_file')) {
    const match = request.match(/[\w./-]*package\.json|[\w./-]+\.[\w]+/);
    steps.push({description: `Read ${match?.[0] ?? 'package.json'}.`, tool: 'files.read_file', input: {path: match?.[0] ?? 'package.json'}});
  }
  return steps.length ? {summary: 'Use available file tools to satisfy the request.', requiresTools: true, needsApproval: true, steps} : {summary: 'No matching tool found. The agent remains refreshingly incapable.', requiresTools: false, needsApproval: false, steps: [{description: 'Explain that no suitable skill is installed.'}]};
}
