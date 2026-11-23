import {useCallback, useRef} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import type {Mode} from '../commands/chatModes.js';

/**
 * Wizard back navigation (UX-03). Every mode change away from a wizard step
 * pushes that step onto a trail, so Esc pops one step (selections and drafts
 * survive because the wizard state is not reset) and only a trail-less wizard
 * step exits to chat. Entering `chat` clears the trail, so a finished flow
 * never leaves a stale path behind.
 */
export function createWizardTrail() {
  const trail: Mode[] = [];
  let current: Mode = 'chat';
  return {
    enter(next: Mode): void {
      if (next === 'chat') trail.length = 0;
      else if (current !== 'chat' && next !== current) trail.push(current);
      current = next;
    },
    /** Steps the current step was reached through, oldest first. */
    steps(): readonly Mode[] {
      return trail;
    },
    current(): Mode {
      return current;
    },
    /** Returns the step to return to, or `undefined` at a wizard root. */
    back(): Mode | undefined {
      const previous = trail.pop();
      if (previous !== undefined) current = previous;
      return previous;
    },
  };
}

/** `setMode` wrapper that records the trail, plus the Esc handler's `goBack`. */
export function useWizardNavigation(setModeRaw: Dispatch<SetStateAction<Mode>>) {
  const trailRef = useRef<ReturnType<typeof createWizardTrail> | undefined>(undefined);
  if (!trailRef.current) trailRef.current = createWizardTrail();
  const trail = trailRef.current;
  const setMode = useCallback((action: SetStateAction<Mode>) => {
    const next = typeof action === 'function' ? action(trail.current()) : action;
    trail.enter(next);
    setModeRaw(next);
  }, [trail, setModeRaw]);
  const goBack = useCallback((): boolean => {
    const previous = trail.back();
    if (previous === undefined) return false;
    setModeRaw(previous);
    return true;
  }, [trail, setModeRaw]);
  return {setMode, goBack};
}
