import fs from 'fs-extra';
import path from 'node:path';
import {MAX_CONTEXT_FILE_CHARS} from '../../config/contextFiles.js';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import type {CommandContext, CommandResult} from './commands.js';

export async function handleInitCommand(ctx: CommandContext): Promise<CommandResult> {
  await ctx.runAgentTurn(buildInitPrompt(), '/init');
  await ctx.refreshContextFiles();
  const agentsMdPath = path.join(process.cwd(), 'AGENTS.md');
  if (await fs.pathExists(agentsMdPath)) {
    const content = await fs.readFile(agentsMdPath, 'utf8');
    const chars = content.length;
    const lines = content.split('\n').length;
    const msg = chars > MAX_CONTEXT_FILE_CHARS
      ? `AGENTS.md validation: ${chars.toLocaleString()} chars / ${lines} lines — exceeds the ${MAX_CONTEXT_FILE_CHARS.toLocaleString()}-char context budget and will be truncated. Trim it before relying on it.`
      : `AGENTS.md validation: ${chars.toLocaleString()} chars / ${lines} lines — within the ${MAX_CONTEXT_FILE_CHARS.toLocaleString()}-char context budget.`;
    ctx.addSystemMessage(msg);
  }
  return 'handled';
}
