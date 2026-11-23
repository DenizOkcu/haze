import {render} from 'ink';
import {readSettings} from '../../config/settings.js';
import {clearTasks as clearTasksFromStore} from '../../core/tasks/taskStorage.js';
import {DEFAULT_THEME_NAME, resolveTheme, setActiveTheme, theme} from '../../ui/theme.js';
import {applyTerminalColors, resetTerminalColors} from '../../ui/terminalColors.js';
import {runTerminalSession} from '../chat/shutdown.js';
import {installViewportResizeGuard} from '../chat/resizeGuard.js';
import {clearRenderMetricsReader, setRenderMetricsReader} from '../chat/renderMetrics.js';
import {ChatScreen, type ChatOptions} from '../chat/ChatScreen.js';

export async function chatCommand(options: ChatOptions = {}) {
  // Resolve the theme before any Ink output so every component renders with it.
  // Settings failures must not block startup (the in-app banner already reports
  // them), but an unknown theme name fails loudly with the valid names listed.
  try {
    setActiveTheme(resolveTheme((await readSettings()).theme));
  } catch (error) {
    console.error(`[haze] ${error instanceof Error ? error.message : String(error)}; using the ${DEFAULT_THEME_NAME} theme.`);
  }
  await clearTasksFromStore().catch(() => undefined);
  let shutdown: (() => Promise<void>) | undefined;
  // Sampled by the --debug onRender hook; read by ChatScreen's debug panel via
  // a getter so the metric never enters React state (no extra re-renders).
  let lastRenderMetricsMs: {at: number; renderTime: number} | undefined;
  setRenderMetricsReader(() => lastRenderMetricsMs);
  // Clear on width changes ahead of Ink's repaint; ChatScreen then replays
  // its width-keyed Static transcript instead of leaving a blank viewport.
  const removeResizeGuard = installViewportResizeGuard();
  await runTerminalSession({
    adopt: () => {
      if (!process.stdout.isTTY) return;
      // Clear the viewport, not preexisting terminal scrollback.
      process.stdout.write('\u001B[2J\u001B[H');
      applyTerminalColors(theme.foreground, theme.background);
    },
    create: () => render(<ChatScreen {...options} onShutdownReady={owner => { shutdown = owner; }} />, {
      incrementalRendering: true,
      maxFps: 15,
      kittyKeyboard: {mode: 'auto', flags: ['disambiguateEscapeCodes']},
      exitOnCtrlC: false,
      // Ink 8 render metrics: direct observability of per-frame render cost
      // under --debug, alongside the estimator-based live-region clamp.
      ...(options.debug ? {onRender: ({renderTime}: {renderTime: number}) => {
        lastRenderMetricsMs = {at: Date.now(), renderTime};
      }} : {}),
    }),
    shutdown: () => shutdown?.(),
    restore: () => {
      removeResizeGuard();
      clearRenderMetricsReader();
      resetTerminalColors();
    },
  });
}
