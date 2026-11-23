/**
 * Terminal default color control via OSC escape sequences.
 *
 * A haze theme paints both terminal defaults, not just one side:
 *   OSC 10  — default foreground (the theme's `foreground` role)
 *   OSC 11  — default background (the theme's `background` role)
 *   OSC 110/111 — restore the terminal's own defaults on exit
 *
 * This pairing matters because haze renders plenty of unstyled `<Text>` that
 * inherits the terminal defaults (diff code lines, plain transcript text).
 * Adopting only the background would repaint that text's canvas — e.g. to
 * Solarized Light's cream — while a dark-configured terminal keeps its white
 * default foreground: unreadable. Adopting both sides keeps fg/bg contrast
 * owned by the theme. Supported terminals (iTerm2, kitty, alacritty, wezterm,
 * xterm, gnome-terminal, foot, …) honor the sequences; others ignore them, so
 * haze stays as readable as the terminal's own configuration.
 *
 * Helpers are write-only on purpose: querying current colors (OSC 10/11 ?)
 * would race the Ink app for stdin. Malformed colors never emit anything.
 */

/** Minimal writable-terminal shape so tests can pass a fake stream. */
export interface TerminalColorStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

const HEX_COLOR = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;

/** `#rrggbb` → OSC rgb payload (`rr/gg/bb`), or undefined for malformed input. */
function oscRgb(color: string): string | undefined {
  const match = HEX_COLOR.exec(color.trim());
  if (!match) return undefined;
  const [, r = '', g = '', b = ''] = match;
  return `${r.toLowerCase()}/${g.toLowerCase()}/${b.toLowerCase()}`;
}

/**
 * OSC 10/11 are written raw (chalk never sees them), so they need their own
 * capability gate: only on a TTY that reports truecolor (COLORTERM) or forced
 * color, and never under NO_COLOR. Terminals without the capability ignore
 * the sequences anyway, but a dumb/CI capture would otherwise keep the bytes
 * (FE-13).
 */
function oscCapable(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false') return true;
  const colorterm = env.COLORTERM?.toLowerCase();
  return colorterm === 'truecolor' || colorterm === '24bit';
}

/** Adopt a theme's foreground/background as the terminal defaults (OSC 10 + 11). Malformed parts are skipped; no-op off-TTY or without colour capability. */
export function applyTerminalColors(foreground: string, background: string, stream: TerminalColorStream = process.stdout, env: NodeJS.ProcessEnv = process.env): void {
  if (!stream.isTTY || !oscCapable(env)) return;
  const fg = oscRgb(foreground);
  const bg = oscRgb(background);
  if (fg) stream.write(`\u001B]10;rgb:${fg}\u0007`);
  if (bg) stream.write(`\u001B]11;rgb:${bg}\u0007`);
}

/** Restore the terminal's own default colors (OSC 110 + 111). No-op off-TTY or without colour capability. */
export function resetTerminalColors(stream: TerminalColorStream = process.stdout, env: NodeJS.ProcessEnv = process.env): void {
  if (!stream.isTTY || !oscCapable(env)) return;
  stream.write('\u001B]110\u0007');
  stream.write('\u001B]111\u0007');
}
