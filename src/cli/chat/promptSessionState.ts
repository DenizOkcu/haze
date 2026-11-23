import {useRef, useState} from 'react';
import type {PromptSession} from '../../llm/systemPrompt.js';
import type {StoredReasoningSetting} from '../../core/agent/reasoningPolicy.js';

/**
 * The stable per-session PromptSession plus the per-model reasoning overrides
 * stored on it, extracted from `ChatScreen` (ARCH-05).
 */
export function usePromptSession(sessionStartRef: React.MutableRefObject<Date>) {
  // Stable PromptSession object across turns so per-session flags (the
  // context-fallback warning key) persist; rebuilt when a new session starts,
  // detected by sessionStartRef identity (the lifecycle controller replaces
  // the Date on new/resume/continue).
  const promptSessionRef = useRef<{identity: Date | undefined; value: PromptSession}>({identity: undefined, value: {cwd: process.cwd()}});
  // Session per-model reasoning overrides live on the stable PromptSession
  // object; this counter only forces a re-render so the status bar updates.
  const [reasoningOverrideCounter, setReasoningOverrideCounter] = useState(0);

  /**
   * The PromptSession shared by every turn of the active session. Returning a
   * stable object (not a fresh literal per turn) is what makes once-per-session
   * affordances actually once-per-session; a new session identity yields a
   * fresh object so they fire again at its start.
   */
  function currentPromptSession(): PromptSession {
    if (promptSessionRef.current.identity !== sessionStartRef.current) {
      promptSessionRef.current = {identity: sessionStartRef.current, value: {start: sessionStartRef.current, cwd: process.cwd()}};
    }
    return promptSessionRef.current.value;
  }

  function setSessionReasoningOverride(modelSelector: string, setting: StoredReasoningSetting | undefined) {
    const session = currentPromptSession();
    if (setting === undefined) {
      if (session.reasoningByModel) delete session.reasoningByModel[modelSelector];
    } else {
      session.reasoningByModel = {...session.reasoningByModel, [modelSelector]: setting};
    }
    setReasoningOverrideCounter(count => count + 1);
  }

  return {currentPromptSession, setSessionReasoningOverride, reasoningOverrideCounter};
}
