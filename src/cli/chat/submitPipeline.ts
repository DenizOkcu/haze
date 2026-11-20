import {readSettings, updateSettings} from '../../config/settings.js';
import {readContextFiles} from '../../config/contextFiles.js';
import {formatSession} from '../../core/session/sessionStore.js';
import {loadTasks as loadTasksFromStore} from '../../core/tasks/taskStorage.js';
import {handleSlashCommand, type CommandContext} from '../commands/commands.js';
import {isPausedGoalRecoveryCommand, contextFileSignatureMap} from './userInput.js';
import {buildContextReport} from './contextReport.js';
import type {ChatScreenDeps} from './screenDeps.js';

/**
 * The chat input submit pipeline: exit shortcut, settings repair, busy
 * queueing, wizard dispatch, skill invocation, slash commands, then the
 * agent turn. Extracted from `chat.tsx` (CR-006 pattern) — pure code motion
 * over the explicit deps bundle.
 */
export async function submit(deps: ChatScreenDeps, value: string) {
  const {
    stoppingRef, mode, shutdown, settingsError, setSettings, setSettingsError, setMessages,
    busy, followUps, pausedResume, setPausedResume, wizard, skillInvocation, doAgentTurn,
    settings, contextFiles, setMode, updateWizard, sessionLifecycle, noSession,
    openSessionPicker, sessionRef, terminalControl, refreshSkills, openPluginPicker,
    setContextFiles, contextFileSignaturesRef, currentPromptSession, setSessionReasoningOverride,
    sessionStartRef, conversationRef, clearLiveMessages, lastAssistantTextRef,
    prepareUserInput, setVisibleTasks, setTaskBarPadding,
  } = deps;
  if (stoppingRef.current) return;
  if (mode === 'chat' && /^\/(?:exit|quit)\s*$/i.test(value)) return shutdown();
  if (settingsError) {
    try {
      const repaired = await readSettings();
      setSettings(repaired, {});
      setSettingsError(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      if (!/^\/(?:settings\s+(?:open|edit)|help|exit|quit)\b/i.test(value.trim())) {
        setMessages(messages => [...messages, {role: 'system', text: `${message}\nRepair settings, then retry. /settings edit (or /settings open), /help, and /exit remain available.`}]);
        return;
      }
    }
  }
  if (busy) {
    if (mode === 'chat') followUps.queue(value);
    return;
  }
  // A new goal or session reset supersedes the paused-goal resume affordance;
  // recovery/configuration commands (compact, model, provider, settings,
  // resume…) intentionally keep it — the pause notice tells the user to run
  // exactly those and then press R (SU-04).
  const isRecoveryCommand = isPausedGoalRecoveryCommand(mode, value);
  if (pausedResume && !isRecoveryCommand) setPausedResume(undefined);

  if (await wizard.dispatch(mode, value)) return;

  const invokedSkill = skillInvocation(value);
  if (invokedSkill) {
    const argumentText = invokedSkill.args ? `\nUser-provided skill arguments: ${invokedSkill.args}` : '';
    await doAgentTurn(`The user explicitly invoked the "${invokedSkill.skill.name}" skill. Call skill with name="${invokedSkill.skill.name}" and follow its returned instructions.${argumentText}`, value);
    return;
  }

  const {clearConversation, compactConversation, compactConversationWithModel} = sessionLifecycle;
  const ctx: CommandContext = {
    settings,
    contextFiles,
    setMode,
    setModelProviderFilter: (filter: string | undefined) => updateWizard({type: 'set', key: 'modelProviderFilter', value: filter}),
    addSystemMessage: text => setMessages(m => [...m, {role: 'system', text}]),
    clearConversation,
    newSession: async () => {
      conversationRef.current = [];
      lastAssistantTextRef.current = '';
      clearLiveMessages();
      setMessages([{role: 'system', text: 'Started fresh. The fog parts.'}]);
      await sessionLifecycle.startNewSession('New session started.');
    },
    resumeSession: noSession ? undefined : async id => {
      if (id) await sessionLifecycle.resumeSessionById(id);
      else await openSessionPicker();
    },
    sessionInfo: () => sessionRef.current ? formatSession(sessionRef.current) : 'Session persistence is off.',
    compactConversation,
    compactConversationLlm: compactConversationWithModel,
    runAgentTurn: (prompt, displayValue, options) => doAgentTurn(prompt, displayValue, options),
    composeInEditor: async () => {
      const text = await terminalControl.composeInEditor();
      if (text === undefined) setMessages(m => [...m, {role: 'system', text: '/editor needs $EDITOR (or $VISUAL) set to an editor command.'}]);
      return text;
    },
    viewInPager: terminalControl.viewInPager,
    editFileInEditor: terminalControl.editFileInEditor,
    refreshSkills,
    openPluginPicker,
    refreshContextFiles: async () => {
      const files = await readContextFiles().catch(() => contextFiles);
      setContextFiles(files);
      contextFileSignaturesRef.current = contextFileSignatureMap(files);
      return files;
    },
    updateSettings: async patch => {
      const next = await updateSettings(patch);
      setSettings(next, patch);
      return deps.settingsRef.current;
    },
    getSessionReasoning: modelSelector => currentPromptSession().reasoningByModel?.[modelSelector],
    setSessionReasoning: setSessionReasoningOverride,
    getContextReport: () => buildContextReport({sessionStart: sessionStartRef.current, contextFiles, conversation: conversationRef.current}),
  };
  let result;
  try {
    result = await handleSlashCommand(value, ctx);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    setMessages(m => [...m, {role: 'system', text: `Command failed: ${text}`}]);
    return;
  }
  if (result === 'exit') return shutdown();
  if (result === 'handled') {
    if (value === '/clear') {
      loadTasksFromStore().then(t => { setVisibleTasks(t); setTaskBarPadding(0); }).catch(() => undefined);
    }
    return;
  }

  const prepared = await prepareUserInput(value);
  if (!prepared) return;
  await doAgentTurn(prepared.value, prepared.displayValue, prepared.options);
}
