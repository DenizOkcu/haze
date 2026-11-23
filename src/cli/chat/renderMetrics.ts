export type RenderMetrics = {at: number; renderTime: number};
export type RenderMetricsReader = () => RenderMetrics | undefined;

// Module-level on purpose: the Ink render options live outside React, and the
// debug panel reads the latest value through a getter so it never enters state
// (no extra re-renders). `commands/chat.tsx` installs the reader and clears it
// when the terminal session restores; `ChatScreen` consumes it.
let renderMetricsReader: RenderMetricsReader | undefined;

export function setRenderMetricsReader(reader: RenderMetricsReader): void {
  renderMetricsReader = reader;
}

export function clearRenderMetricsReader(): void {
  renderMetricsReader = undefined;
}

export function readRenderMetrics(): RenderMetrics | undefined {
  return renderMetricsReader?.();
}
