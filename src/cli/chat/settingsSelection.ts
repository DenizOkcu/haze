import React, {useRef, useState} from 'react';
import type {ModelMessage} from 'ai';
import type {HazeSettings} from '../../config/settings.js';
import {activeModel, providerEndpointFingerprint} from '../../config/providers.js';
import {transitionProviderConversation} from '../../core/agent/providerTransition.js';
import {mergeSettingsSelection} from './userInput.js';
import type {SessionRecorder} from './sessionRecorder.js';
import type {Message} from '../commands/streaming.js';

export type SettingsSelection = {provider: string; model: string; endpointFingerprint?: string};

export type SettingsSelectionDeps = {
  conversationRef: React.MutableRefObject<ModelMessage[]>;
  sessionRecorderRef: React.MutableRefObject<SessionRecorder | undefined>;
  setMessages: (updater: React.SetStateAction<Message[]>) => void;
};

/**
 * Settings state plus the session-pinned model selection, extracted from
 * `ChatScreen` (ARCH-05). `setSettings` records the global default before a
 * patch merge so unrelated settings writes never replace a resumed session's
 * model (merge policy in chat/userInput.ts), converts the conversation when the
 * selected model or provider endpoint changes, and records `model_selection`.
 */
export function useSettingsSelection({conversationRef, sessionRecorderRef, setMessages}: SettingsSelectionDeps) {
  const [settings, setSettingsRaw] = useState<HazeSettings>({});
  const settingsRef = useRef<HazeSettings>({});
  const defaultSelectionRef = useRef<{provider?: string; model?: string}>({});

  function currentModelSelection(): SettingsSelection | undefined {
    const {provider, model} = settingsRef.current;
    const selected = activeModel(settingsRef.current);
    return provider && model ? {provider, model, ...(selected ? {endpointFingerprint: providerEndpointFingerprint(selected.provider)} : {})} : undefined;
  }

  function setSettings(next: HazeSettings, patch?: HazeSettings) {
    const previousSelection = currentModelSelection();
    const previousProvider = activeModel(settingsRef.current)?.provider;
    // The ref records the global default from `next` (what updateSettings
    // returned) before the patch merge; unrelated settings writes must not
    // replace a resumed session's model (merge policy in chat/userInput.ts).
    defaultSelectionRef.current = {provider: next.provider, model: next.model};
    settingsRef.current = patch ? mergeSettingsSelection(next, settingsRef.current, patch) : next;
    const selected = currentModelSelection();
    const selectedProvider = activeModel(settingsRef.current)?.provider;
    const changedEndpoint = selectedProvider && (!previousProvider || previousProvider.url !== selectedProvider.url || previousProvider.kind !== selectedProvider.kind);
    if (patch && previousSelection && selected && (previousSelection.provider !== selected.provider || previousSelection.model !== selected.model || changedEndpoint) && conversationRef.current.length) {
      conversationRef.current = transitionProviderConversation(conversationRef.current);
      sessionRecorderRef.current?.recordModelTransition(conversationRef.current, selected);
      setMessages(messages => [...messages, {role: 'system', text: 'Model changed: previous tool history was converted to text and provider reasoning state was cleared.'}]);
    }
    setSettingsRaw(settingsRef.current);
    if (patch && ('provider' in patch || 'model' in patch)) {
      if (selected) sessionRecorderRef.current?.recordModelSelection(selected);
    }
  }

  // Direct state sync for the resume/continue/fork selection restore: no
  // provider transition, the conversation is replaced by the lifecycle anyway.
  return {settings, settingsRef, defaultSelectionRef, setSettings, setSettingsRaw, currentModelSelection};
}
