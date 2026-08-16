import {tool} from 'ai';
import {z} from 'zod';
import {getBackgroundProcess, killBackgroundProcess, listBackgroundProcesses} from '../../core/process/backgroundRegistry.js';
import {readToolOutput} from '../../core/agent/toolOutputStore.js';
import {hazeContext, hazeToolContextSchema} from './toolContext.js';

export const processTool = tool({
  description: 'List, read output from, or kill background processes started by shell background=true. Kill servers and watchers when finished.',
  contextSchema: hazeToolContextSchema,
  inputSchema: z.object({
    action: z.enum(['list', 'output', 'kill']),
    backgroundId: z.string().optional().describe('Required for output and kill, e.g. background-1'),
    offset: z.number().int().nonnegative().default(0).describe('Character offset for output'),
    limit: z.number().int().positive().max(20_000).default(12_000).describe('Maximum output characters'),
  }),
  execute: async ({action, backgroundId, offset, limit}, context) => {
    if (hazeContext(context)?.isSubagent) {
      return {ok: false, reasonCode: 'background_not_allowed', recoverable: false, error: 'Background processes are unavailable in fleet workers.', suggestedNextStep: 'Manage background processes from the main conversation.'};
    }
    if (action === 'list') {
      return {ok: true, processes: listBackgroundProcesses()};
    }
    if (!backgroundId) {
      return {ok: false, reasonCode: 'process_id_required', recoverable: true, error: `backgroundId is required for process action=${action}.`, suggestedNextStep: 'Call process action=list and retry with an existing backgroundId.'};
    }
    const existing = getBackgroundProcess(backgroundId);
    if (!existing) {
      return {ok: false, reasonCode: 'process_not_found', recoverable: true, error: `No background process named ${backgroundId}.`, suggestedNextStep: 'Call process action=list to get current ids.'};
    }
    if (action === 'output') {
      const page = readToolOutput(existing.outputHandle, offset, limit);
      return page ? {ok: true, backgroundId, status: existing.status, outputHandle: existing.outputHandle, ...page} : {ok: false, reasonCode: 'output_expired', recoverable: false, error: `Output handle for ${backgroundId} has expired.`, suggestedNextStep: 'Restart the background process if its output is still needed.'};
    }
    if (existing.status !== 'running') {
      return {ok: false, reasonCode: 'process_already_exited', recoverable: false, error: `${backgroundId} is already ${existing.status}.`, suggestedNextStep: 'Call process action=list to inspect remaining processes.'};
    }
    const killed = await killBackgroundProcess(backgroundId);
    return killed?.status === 'killed'
      ? {ok: true, action: 'kill', process: killed}
      : {ok: false, reasonCode: 'process_kill_failed', recoverable: false, error: killed?.error ?? `Failed to kill ${backgroundId}.`, suggestedNextStep: 'Stop haze to trigger final process-tree teardown, then inspect the host process list.'};
  },
});
