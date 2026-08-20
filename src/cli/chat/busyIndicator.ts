import {useEffect, useRef, useState} from 'react';
import {formatElapsedTimeWhole} from '../../utils/format.js';

/** Elapsed-time label for the busy indicator heartbeat, or '' when no turn is active. */
function busyElapsedLabel(startedAt: number | undefined) {
  if (startedAt == null) return '';
  const elapsed = Date.now() - startedAt;
  return elapsed > 0 ? formatElapsedTimeWhole(elapsed) : '';
}

/**
 * Busy state with a one-second heartbeat. The tick re-renders the elapsed-time
 * label so the developer always sees rolling activity even when the model is
 * thinking with no streamed output and no tool is running (the "looks stuck"
 * problem). Extracted from ChatScreen alongside BusyBar.
 */
export function useBusyIndicator() {
  const [busy, setBusyState] = useState(false);
  const turnStartedAtRef = useRef<number | undefined>(undefined);
  const [, setBusyTick] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const heartbeat = setInterval(() => setBusyTick(tick => tick + 1), 1000);
    return () => clearInterval(heartbeat);
  }, [busy]);

  function setBusy(nextBusy: boolean) {
    if (nextBusy && !busy) turnStartedAtRef.current = Date.now();
    if (!nextBusy) turnStartedAtRef.current = undefined;
    setBusyState(nextBusy);
  }

  return {busy, setBusy, elapsed: busyElapsedLabel(turnStartedAtRef.current)};
}
