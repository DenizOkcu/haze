import {shellTool} from '../../llm/tools/shellTool.js';
import {userCommandStatus, type UserCommandRun} from '../../core/agent/userCommands.js';

type Caller = Parameters<NonNullable<typeof shellTool.execute>>[1];
const CALLER: Caller = {toolCallId: 'user-command', messages: [], context: {}};
const EMPTY_STREAM = {text: '', truncated: false, filtered: false, omittedChars: 0};

/**
 * Run one user command (`! <command>`) through the model's `shell` tool, so
 * both paths share one execution, bounds, env cleaning and output reduction.
 * Called outside a turn: there is no tool context, so nothing is deduplicated
 * and the result's validation summary is never observed or recorded. Resolves
 * with a run result instead of throwing.
 */
export async function runUserCommand(input: {command: string; signal?: AbortSignal}): Promise<UserCommandRun> {
  try {
    const context: Caller = {...CALLER, ...(input.signal ? {abortSignal: input.signal} : {})};
    return toUserCommandRun(await shellTool.execute!({command: input.command}, context));
  } catch (error) {
    return {command: input.command, status: 'error', exitCode: null, durationMs: 0, stdout: {...EMPTY_STREAM}, stderr: {...EMPTY_STREAM}, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Map a `shell` tool result onto the run shape. */
export function toUserCommandRun(result: unknown): UserCommandRun {
  const tool = record(result);
  if (!tool) return {command: '', status: 'error', exitCode: null, durationMs: 0, stdout: {...EMPTY_STREAM}, stderr: {...EMPTY_STREAM}, error: 'shell tool returned no result'};
  const stdout = stream(tool.stdout);
  const stderr = stream(tool.stderr);
  const command = typeof tool.command === 'string' ? tool.command : '';
  const code = typeof tool.code === 'number' ? tool.code : null;
  const error = typeof tool.error === 'string' ? tool.error : undefined;
  return {
    command,
    status: userCommandStatus({code, timedOut: tool.timedOut === true, aborted: tool.aborted === true, ...(error ? {error} : {})}),

    exitCode: code,
    durationMs: typeof tool?.durationMs === 'number' ? tool.durationMs : 0,
    stdout,
    stderr,
    ...(error ? {error} : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stream(value: unknown) {
  const candidate = record(value);
  if (!candidate || typeof candidate.text !== 'string') return {...EMPTY_STREAM};
  const handle = [candidate.handle, candidate.rawHandle].find(entry => typeof entry === 'string');
  return {
    text: candidate.text,
    truncated: candidate.truncated === true,
    filtered: false,
    omittedChars: typeof candidate.omittedChars === 'number' ? candidate.omittedChars : 0,
    ...(handle ? {handle: handle as string} : {}),
  };
}
