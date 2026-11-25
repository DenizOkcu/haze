import type {ModelMessage} from 'ai';
import {formatUserCommandRecord, parseUserInputLine, USER_COMMAND_RESPONSE_REQUEST, userCommandHead, userCommandTranscriptText} from '../../core/agent/userCommands.js';
import {runUserCommand} from './userCommandRunner.js';
import type {ChatScreenDeps} from './screenDeps.js';

export const NO_USER_COMMAND_MESSAGE = 'No command given after "!".';

/**
 * Run one user command (`! <command>`) end to end: busy label, cancel wiring,
 * transcript row, durable conversation record, one model turn over the output
 * (skipped when the user cancelled), then the follow-up queue drain (the
 * existing drain only runs after agent turns).
 */
export async function runUserCommandLine(deps: ChatScreenDeps, command: string) {
  if (deps.stoppingRef.current) return;
  const controller = new AbortController();
  const startedAt = Date.now();
  // Esc cancels through the shared abort ref (cancelThinking).
  deps.abortControllerRef.current = controller;
  deps.setBusyLabel(`! ${userCommandHead(command)}`);
  deps.setBusy(true);
  let run;
  try {
    run = await runUserCommand({command, signal: controller.signal});
  } finally {
    deps.abortControllerRef.current = null;
    deps.setBusy(false);
  }
  if (deps.sealedRef.current) return;
  deps.finalizeMessage({role: 'tool', text: userCommandTranscriptText(run), startedAt, finishedAt: Date.now()});

  deps.conversationRef.current = [...deps.conversationRef.current, {role: 'user', content: formatUserCommandRecord(run)} satisfies ModelMessage];
  deps.sessionRecorderRef.current?.recordConversation(deps.conversationRef.current);
  await deps.sessionRecorderRef.current?.flush().catch(deps.showPersistenceWarning);
  if (run.status !== 'cancelled' && !deps.stoppingRef.current && !deps.sealedRef.current) {
    await deps.doAgentTurn(USER_COMMAND_RESPONSE_REQUEST, `! ${userCommandHead(command)}`);
  }
  for (let next = deps.followUps.takeNext(); !deps.stoppingRef.current && next !== undefined; next = deps.followUps.takeNext()) {
    const routed = await routeQueuedLine(deps, next);
    if (routed.handled) continue;
    const prepared = await deps.prepareUserInput(routed.value);
    if (prepared) await deps.doAgentTurn(prepared.value, prepared.displayValue, prepared.options);
  }
}

/**
 * Route one queued line: a `!` command runs as a user command, `\!` loses its
 * backslash, anything else is returned unchanged for the normal agent path.
 */
export async function routeQueuedLine(deps: ChatScreenDeps, line: string): Promise<{handled: true} | {handled: false; value: string}> {
  const parsed = parseUserInputLine(line);
  if (parsed.kind === 'command') {
    if (parsed.command) await runUserCommandLine(deps, parsed.command);
    else deps.setMessages(m => [...m, {role: 'system', text: NO_USER_COMMAND_MESSAGE}]);
    return {handled: true};
  }
  return {handled: false, value: parsed.kind === 'escaped' ? parsed.value : line};
}
