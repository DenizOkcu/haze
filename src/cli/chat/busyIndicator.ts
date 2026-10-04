import {useRef, useState} from 'react';
import {useAnimation, useIsScreenReaderEnabled} from 'ink';
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
 * problem). Extracted from ChatScreen alongside BusyBar. The heartbeat rides
 * Ink 8's shared animation timer so every animated component (spinners,
 * elapsed labels) consolidates into one render cycle under maxFps.
 */
export function useBusyIndicator() {
  const [busy, setBusyState] = useState(false);
  const turnStartedAtRef = useRef<number | undefined>(undefined);
  const screenReader = useIsScreenReaderEnabled();
  // Whole-second elapsed labels: one shared-timer frame per second is enough.
  // Screen-reader mode keeps the elapsed text static between turns instead
  // of announcing a re-render every second. The animation state update itself
  // re-renders this component, refreshing the elapsed label below.
  useAnimation({interval: 1000, isActive: busy && !screenReader});

  function setBusy(nextBusy: boolean) {
    if (nextBusy && !busy) turnStartedAtRef.current = Date.now();
    if (!nextBusy) turnStartedAtRef.current = undefined;
    setBusyState(nextBusy);
  }

  return {busy, setBusy, elapsed: busyElapsedLabel(turnStartedAtRef.current)};
}
