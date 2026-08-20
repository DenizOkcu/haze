/** Human-readable byte sizes for display text (CLI rows, session placeholders). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact token counts for status rows: 999, 1.5k, 13k, 1.5m. */
export function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

/** Milliseconds as fractional seconds, e.g. "1.2s". */
export function formatSeconds(milliseconds: number) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

/** Minutes for timeout/deadline copy, e.g. "5 minutes". */
export function formatIdleMinutes(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Elapsed time with fractional seconds: "1.5s", "2m 03.4s", "1h 02m 03.4s". */
export function formatElapsedTime(milliseconds: number) {
  const totalSeconds = Math.max(0, milliseconds / 1000);
  const wholeSeconds = Math.floor(totalSeconds);
  const seconds = totalSeconds - Math.floor(wholeSeconds / 60) * 60;
  const totalMinutes = Math.floor(wholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const secondsLabel = `${seconds.toFixed(1)}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${secondsLabel}`;
  if (minutes > 0) return `${minutes}m ${secondsLabel}`;
  return secondsLabel;
}

/** Elapsed time in whole seconds: "1s", "2m 03s", "1h 02m 03s". */
export function formatElapsedTimeWhole(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
