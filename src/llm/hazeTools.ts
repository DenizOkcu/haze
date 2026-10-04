import {writeTasksTool} from './tools/taskTool.js';
import {readToolOutputTool} from './tools/storedOutputTool.js';
import {fileTools} from './tools/fileTools.js';
import {fetchTool} from './tools/fetchTool.js';
import {shellTool} from './tools/shellTool.js';
import {processTool} from './tools/processTool.js';

/**
 * The public built-in tool catalog. Implementations live in `tools/`
 * (`fileTools.ts` holds the workspace file tools); this file only composes.
 */
export const hazeTools = {
  ...fileTools,
  writeTasks: writeTasksTool,
  readToolOutput: readToolOutputTool,
  fetch: fetchTool,
  shell: shellTool,
  process: processTool,
};
