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

/** Adopt a theme's foreground/background as the terminal defaults (OSC 10 + 11). Malformed parts are skipped; no-op off-TTY. */
export function applyTerminalColors(foreground: string, background: string, stream: TerminalColorStream = process.stdout): void {
  if (!stream.isTTY) return;
  const fg = oscRgb(foreground);
  const bg = oscRgb(background);
  if (fg) stream.write(`\u001B]10;rgb:${fg}\u0007`);
  if (bg) stream.write(`\u001B]11;rgb:${bg}\u0007`);
}

/** Restore the terminal's own default colors (OSC 110 + 111). No-op off-TTY. */
export function resetTerminalColors(stream: TerminalColorStream = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write('\u001B]110\u0007');
  stream.write('\u001B]111\u0007');
}
