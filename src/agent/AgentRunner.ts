import {confirm} from '@inquirer/prompts';
import {generateText} from 'ai';
import {model} from '../llm/client.js';
import {SkillRegistry} from '../skills/SkillRegistry.js';
import {ToolExecutor} from '../tools/ToolExecutor.js';
import {createPlan} from './planner.js';
import {addMemory} from './memory.js';
import type {AgentResult} from './types.js';

export class AgentRunner {
  async run(request: string): Promise<AgentResult> {
    const registry = await new SkillRegistry().load();
    const plan = await createPlan(request, registry);
    const toolResults: unknown[] = [];
    if (plan.requiresTools) {
      const ok = await confirm({message: 'Approve tool execution? (Haze will not become sentient either way)', default: false});
      if (!ok) return {plan, toolResults, summary: 'Execution cancelled.'};
      const executor = new ToolExecutor();
      for (const step of plan.steps.filter(s => s.tool)) {
        const tool = registry.tools.get(step.tool!);
        if (!tool) throw new Error(`Unknown tool: ${step.tool}`);
        const skill = registry.skills.get(tool.skillName)!;
        toolResults.push({tool: tool.id, result: await executor.execute(tool, skill, step.input ?? {})});
      }
    }
    const summary = await summarize(request, toolResults, plan.summary);
    await addMemory(request, summary).catch(() => undefined);
    return {plan, toolResults, summary};
  }
}

async function summarize(request: string, results: unknown[], fallback: string) {
  const m = model();
  if (!m) return results.length ? JSON.stringify(results, null, 2) : fallback;
  const {text} = await generateText({model: m, prompt: `Summarize this Haze run concisely. Request: ${request}\nResults: ${JSON.stringify(results)}`});
  return text;
}
