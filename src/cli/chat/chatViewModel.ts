import {useMemo} from 'react';
import type {HazeSettings} from '../../config/settings.js';
import {activeModel} from '../../config/providers.js';
import {resolveProviderReasoning} from '../../config/providerReasoning.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {isStoredReasoning, resolveReasoningChoice} from '../../core/agent/reasoningPolicy.js';
import type {SessionSummary} from '../../core/session/sessionStore.js';
import type {LoadedSkill} from '../../skills/types.js';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {Message} from '../commands/streaming.js';
import type {TokenUsage} from '../commands/streaming/turnRuntime.js';
import {placeholderForMode, type Mode} from '../commands/chatModes.js';
import {busyDetailLabel, compactHomePath, statusBarMetrics, type FleetStatus} from './chatMetrics.js';
import {inputSuggestionsForState} from './inputSuggestions.js';
import {partitionDisplayMessages} from './transcriptPartition.js';
import type {WizardUiState} from './wizard/uiState.js';

/** The session's pinned `provider:model` selection, when one is recorded. */
export type ModelSelection = {provider: string; model: string; endpointFingerprint?: string};

/**
 * Status-bar model name and reasoning suffix for the current screen state.
 * Pure: the name marks a selection that no longer resolves, and the suffix
 * shows the level that will actually be requested (`(no reasoning parameter)`
 * for `unset`, `(provider default)` when the protocol cannot carry a level).
 */
export function modelStatusFor(input: {settings: HazeSettings; selectedModel: ModelSelection | undefined; sessionReasoning: PromptSession['reasoningByModel']}): {activeModelName: string; reasoningSuffix: string} {
  const {settings, selectedModel} = input;
  const activeSelection = activeModel(settings);
  const activeModelName = selectedModel ? `${selectedModel.provider}:${selectedModel.model}${activeSelection ? '' : ' (unavailable)'}` : 'unconfigured';
  const activeSelector = activeSelection ? `${activeSelection.provider.name}:${activeSelection.model}` : undefined;
  const effectiveReasoning = activeSelector
    ? resolveReasoningChoice(input.sessionReasoning?.[activeSelector], isStoredReasoning(settings.reasoning) ? settings.reasoning : undefined)
    : undefined;
  const reasoningSuffix = effectiveReasoning
    ? effectiveReasoning.level === undefined
      ? ' (no reasoning parameter)'
      : activeSelection && resolveProviderReasoning(activeSelection.provider, activeSelection.model, effectiveReasoning.level).effective === 'disabled'
        ? ' (provider default)'
      : ` (${effectiveReasoning.level})`
    : '';
  return {activeModelName, reasoningSuffix};
}

/** Horizontal chrome for the live frame (`width`) and the settled Static replay (`replayWidth`). */
export function chatLayoutFor(width: number, replayWidth: number): {horizontalPadding: number; contentWidth: number; replayContentWidth: number} {
  const horizontalPadding = width >= 12 ? 1 : 0;
  return {
    horizontalPadding,
    contentWidth: Math.max(1, width - horizontalPadding * 2),
    replayContentWidth: Math.max(1, replayWidth - (replayWidth >= 12 ? 1 : 0) * 2),
  };
}

export interface ChatViewModelInput {
  messages: Message[];
  liveMessages: Message[];
  busy: boolean;
  fleet: FleetStatus | undefined;
  settings: HazeSettings;
  mode: Mode;
  tokenUsage: TokenUsage;
  backgroundCount: number;
  skills: LoadedSkill[];
  branchName: string | undefined;
  sessions: SessionSummary[];
  wizard: WizardUiState;
  selectedModel: ModelSelection | undefined;
  /** `reasoningByModel` of the current session; a new object identity re-derives the suffix and the picker suggestions. */
  sessionReasoning: PromptSession['reasoningByModel'];
  /** Bumped by `/reasoning`; it only forces the re-render that re-reads `sessionReasoning`. */
  reasoningOverrideCounter: number;
  width: number;
  replayWidth: number;
}

/**
 * Everything `ChatScreen` derives for one render. The heavy work is memoised on
 * the identity of its inputs (FE-03): the 1 Hz busy heartbeat and every stream
 * delta re-render the screen, but only changed messages may re-run Markdown
 * root chunking.
 */
export function useChatViewModel(input: ChatViewModelInput) {
  const {messages, liveMessages, busy, fleet, settings, mode, tokenUsage, backgroundCount, skills, branchName, sessions, wizard, selectedModel, sessionReasoning, reasoningOverrideCounter, width, replayWidth} = input;
  void reasoningOverrideCounter;
  const activeLiveMessages = useMemo(() => liveMessages.filter(message => !message.hidden), [liveMessages]);
  // Recomputed each busy heartbeat (1 Hz) alongside the elapsed label; the
  // streaming-rate estimate rides the already-live message text, so no extra
  // timer or token bookkeeping is introduced.
  const busyDetail = busy ? busyDetailLabel({messages: activeLiveMessages, fleet}) : undefined;
  const {staticItems: staticTranscriptItems, streamingItems} = useMemo(
    () => partitionDisplayMessages([...messages, ...liveMessages].filter(message => !message.hidden)),
    [messages, liveMessages]);
  const placeholder = placeholderForMode(mode, busy);
  const {activeModelName, reasoningSuffix} = modelStatusFor({settings, selectedModel, sessionReasoning});
  const workspaceLabel = `${compactHomePath(process.cwd())}${branchName ? ` (${branchName})` : ''}`;
  const enabledSkillCount = useMemo(
    () => new Set(skills.filter(skill => isSkillEnabled(settings, skill.name, skill.source)).map(skill => skill.name)).size,
    [skills, settings]);
  const metrics = useMemo(
    () => statusBarMetrics({messages: [...messages, ...liveMessages], tokenUsage, enabledSkillCount, backgroundProcessCount: backgroundCount}),
    [messages, liveMessages, tokenUsage, enabledSkillCount, backgroundCount]);
  const {modelProviderFilter, discoveredModels, suggestedModels, selectedProviderName, providerDraft, selectedSkillName, selectedLspName, selectedMcpName, plugins, selectedPluginName, pluginCollectionEntries} = wizard;
  const inputSuggestions = useMemo(
    () => inputSuggestionsForState({mode, settings, skills, sessions, selectedProviderName, modelProviderFilter, providerDraftName: providerDraft.name, discoveredModels, suggestedModels, selectedSkillName, selectedLspName, selectedMcpName, plugins, selectedPluginName, pluginCollectionEntries, sessionReasoning}),
    [mode, settings, skills, sessions, selectedProviderName, modelProviderFilter, providerDraft.name, discoveredModels, suggestedModels, selectedSkillName, selectedLspName, selectedMcpName, plugins, selectedPluginName, pluginCollectionEntries, sessionReasoning]);
  const layout = chatLayoutFor(width, replayWidth);
  return {busyDetail, staticTranscriptItems, streamingItems, placeholder, activeModelName, reasoningSuffix, workspaceLabel, metrics, inputSuggestions, ...layout};
}
