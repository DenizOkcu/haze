import type {ModelMessage} from 'ai';
import type {ContextFile} from '../../config/contextFiles.js';
import {contextBreakdown} from '../../core/agent/contextBudget.js';
import {stripSyntheticControls} from '../../core/agent/requestAssembly.js';
import {modelWithConfig} from '../../llm/client.js';
import {assembleRequestContext} from '../../llm/requestContext.js';
import {closeMcpClients} from '../../llm/mcp.js';
import {formatContextReport} from '../commands/formatters.js';

/**
 * Build the `/context` token report. Extracted from `chat.tsx` (CR-006); takes
 * its inputs explicitly so the component only orchestrates.
 */
export async function buildContextReport(input: {
  sessionStart: Date;
  contextFiles: ContextFile[];
  conversation: ModelMessage[];
}): Promise<string> {
  const runtime = await modelWithConfig({cwd: process.cwd()});
  if (!runtime?.model) {
    return 'No model provider configured. Run /provider to choose or add a provider before /context can estimate tokens.';
  }
  const session = {start: input.sessionStart, cwd: process.cwd()};
  const assembled = await assembleRequestContext({contextFiles: input.contextFiles, session, model: runtime.model});
  try {
    const messages = stripSyntheticControls(input.conversation);
    const breakdown = contextBreakdown({system: assembled.systemPrompt, contextFiles: input.contextFiles, messages, tools: assembled.availableTools});
    const tools = breakdown.toolSchemas.map(tool => ({
      name: tool.name,
      tokens: tool.tokens,
      category: assembled.toolCategories.get(tool.name) ?? 'builtin',
    }));
    return formatContextReport({
      modelLabel: `${runtime.config.providerName}:${runtime.config.modelName}`,
      systemTokens: breakdown.system,
      projectContext: breakdown.projectContext,
      tools,
      messagesByRole: breakdown.messagesByRole,
      toolResults: breakdown.toolResults,
      toolInputs: breakdown.toolInputs,
      syntheticControl: breakdown.syntheticControl,
      logicalInputEstimate: breakdown.logicalInputEstimate,
      messageCount: messages.length,
      mcpErrors: assembled.loadedMcp?.errors ?? [],
    });
  } finally {
    if (assembled.loadedMcp?.clients.length) await closeMcpClients(assembled.loadedMcp.clients);
  }
}
