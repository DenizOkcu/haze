/**
 * Haze theming core, aligned with the oh-my-zsh / zsh `colors` vocabulary so
 * that oh-my-zsh themes port over with minimal effort.
 *
 * oh-my-zsh themes never define RGB colors. They reference terminal palette
 * slots using zsh's `colors` vocabulary:
 *
 *   $fg[cyan]            → the named palette slot `cyan`
 *   $fg_bold[green]      → named slot `green` (bold is a text attribute, not a color)
 *   ${FG[214]} / %F{214} → an xterm-256 color index
 *   %F{#ff8800}          → truecolor hex
 *
 * Haze themes mirror that split in two layers:
 *
 *   1. Palette — `ZSH_NAMED_COLORS`, one entry per zsh `colors` key
 *      (`black red green yellow blue magenta cyan white default`), approximated
 *      as RGB because haze cannot assume the host terminal's palette.
 *      A theme spec may override slots with `palette`.
 *   2. Roles — semantic haze surfaces (accent, command, warning, …) whose
 *      values are written in the same vocabulary an oh-my-zsh theme uses:
 *      a zsh color name, an xterm-256 index string, or `#rrggbb` hex.
 *
 * The built-in themes live in `src/ui/themes/` (one file per theme, named like
 * its oh-my-zsh counterpart) — including ports of famous `.zsh-theme` files
 * where `robbyrussell`'s `$fg_bold[green]➜` becomes `accent: 'green'`, its
 * `$fg[cyan]%c` becomes `command: 'cyan'`, etc. See `src/ui/themes/AGENTS.md`
 * for the full conversion guide and the segment → role translation table.
 */

import {BUILT_IN_THEME_SPECS} from './themes/index.js';
import {purple} from './themes/purple.js';

export {BUILT_IN_THEME_SPECS};

/** The theme used when settings name none; also the fallback base for roles another theme omits. */
export const DEFAULT_THEME_NAME = 'purple';

/** zsh `colors` associative-array keys — exactly the names `$fg[...]` accepts. */
export type ZshColorName = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'default';

export const ZSH_COLOR_NAMES: readonly ZshColorName[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'default'];

/**
 * RGB approximation of the terminal palette slots the zsh names reference,
 * based on the Tango palette (GNOME Terminal's classic default) because
 * oh-my-zsh themes leave the actual RGB to the terminal. `default` approximates
 * the terminal's default foreground color.
 */
export const ZSH_NAMED_COLORS: Record<ZshColorName, string> = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  default: '#ffffff',
};

/** Bright variants (ANSI slots 8–15), used to resolve xterm-256 indices 8–15. */
const ANSI_16_BRIGHT: readonly string[] = [
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

/**
 * A theme color value, written the way oh-my-zsh writes colors:
 * a zsh color name (`'cyan'` for `$fg[cyan]`), an xterm-256 index string
 * (`'214'` for `${FG[214]}`), or truecolor hex (`'#ff8800'` for `%F{#ff8800}`).
 */
export type ColorSpec = ZshColorName | `#${string}` | `${number}`;

/**
 * Resolved theme: every role is a normalized `#rrggbb` string Ink accepts.
 * Semantic surfaces haze actually renders; the oh-my-zsh segment each one
 * inherits from when porting is noted per role.
 */
export interface HazeTheme {
  /** Terminal default background (OSC 11): the canvas behind every haze surface. omz/VS Code/Sublime: the theme's `background`. */
  background: string;
  /** Brand/accent: app header, tool names, markers, links. omz: prompt-symbol segment (`$fg_bold[green]➜`). */
  accent: string;
  /** Dim accent: rules, heading underlines, table borders. omz: separator rules (`${FG[237]}` dashes in af-magic). */
  accentDim: string;
  /** Chrome borders: input box, panels. omz: segment dividers. */
  border: string;
  /** Info/tool headers. omz: secondary segment (`${FG[075]}` git parens in af-magic, `AGNOSTER_STATUS_JOB_FG`). */
  info: string;
  /** Secondary text: hints, timestamps, elisions. omz: muted separators (`${FG[237]}`). */
  muted: string;
  /** Primary text: task titles, diff code lines. omz: `$fg[default]` body text. */
  foreground: string;
  /** Slash commands, paths, handles. omz: cwd segment (`$fg[cyan]%c` in robbyrussell). */
  command: string;
  /** Success text: ✓ icons, completions. omz: exit-status-ok / clean-git colors. */
  success: string;
  /** Background paired with `success` (added diff lines). */
  successBg: string;
  /** Danger text: ✗ icons, removed diff lines. omz: exit-status-fail / `$fg_bold[red]`. */
  danger: string;
  /** Background paired with `danger` (removed diff lines). */
  dangerBg: string;
  /** Warnings, in-progress states. omz: git dirty marker (`$fg[yellow]✗` in robbyrussell). */
  warning: string;
  /** Quoted/user message surfaces. */
  surfaceBg: string;
  /** Code fence / inline code background. */
  codeBg: string;
}

export type HazeThemeRole = keyof HazeTheme;

export const THEME_ROLES: readonly HazeThemeRole[] = [
  'background', 'accent', 'accentDim', 'border', 'info', 'muted', 'foreground', 'command',
  'success', 'successBg', 'danger', 'dangerBg', 'warning', 'surfaceBg', 'codeBg',
];

/**
 * A theme as authored: role values in oh-my-zsh color vocabulary, plus optional
 * palette overrides for themes whose host terminal palette defines the look
 * (e.g. agnoster under Solarized). Roles omitted here inherit the `purple`
 * theme's values, so partial ports are safe.
 */
export interface HazeThemeSpec {
  /** Override terminal palette slots; values must be `#rrggbb` hex. */
  palette?: Partial<Record<ZshColorName, string>>;
  roles?: Partial<Record<HazeThemeRole, ColorSpec>>;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/** xterm-256 index → RGB hex, mirroring zsh's `%F{nnn}` / `${FG[nnn]}` resolution. Base slots 0–7 resolve through the given palette. */
export function xterm256Color(index: number, palette: Record<ZshColorName, string> = ZSH_NAMED_COLORS): string {
  if (index < 8) return palette[ZSH_COLOR_NAMES[index]!]!.toLowerCase();
  if (index < 16) return ANSI_16_BRIGHT[index - 8]!;
  if (index <= 231) {
    const n = index - 16;
    const r = XTERM_CUBE_LEVELS[Math.floor(n / 36)]!;
    const g = XTERM_CUBE_LEVELS[Math.floor(n / 6) % 6]!;
    const b = XTERM_CUBE_LEVELS[n % 6]!;
    return toHex(r, g, b);
  }
  const gray = 8 + 10 * (index - 232);
  return toHex(gray, gray, gray);
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) => v.toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Resolve a color spec (`'cyan'`, `'214'`, `'#ff8800'`) to `#rrggbb` hex.
 * Throws with the accepted vocabulary for unknown values (fail loudly).
 */
export function resolveColorSpec(spec: string, palette: Record<ZshColorName, string> = ZSH_NAMED_COLORS): string {
  const value = spec.trim();
  if (HEX_COLOR.test(value)) return value.toLowerCase();
  if (/^[0-9]{1,3}$/.test(value)) {
    const index = Number(value);
    if (index <= 255) return xterm256Color(index, palette);
  }
  if ((ZSH_COLOR_NAMES as readonly string[]).includes(value)) return palette[value as ZshColorName].toLowerCase();
  throw new Error(`Unknown color "${spec}". Use a zsh color name (${ZSH_COLOR_NAMES.join(', ')}), an xterm-256 index like "214", or hex like "#ff8800".`);
}

/** Resolve a built-in theme name (+ optional role overrides) to a complete `HazeTheme`. Throws with valid names for unknown themes. */
export function resolveTheme(name?: string, overrides?: Partial<Record<HazeThemeRole, string>>): HazeTheme {
  const spec = BUILT_IN_THEME_SPECS[name ?? DEFAULT_THEME_NAME];
  if (!spec) {
    const validNames = Object.keys(BUILT_IN_THEME_SPECS).join(', ');
    throw new Error(`Unknown theme name "${name}". Valid themes: ${validNames}`);
  }
  const palette: Record<ZshColorName, string> = {...ZSH_NAMED_COLORS};
  for (const [slot, value] of Object.entries(spec.palette ?? {})) {
    if (!(ZSH_COLOR_NAMES as readonly string[]).includes(slot)) {
      throw new Error(`Unknown palette color "${slot}" in theme "${name}". Valid palette colors: ${ZSH_COLOR_NAMES.join(', ')}.`);
    }
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
      throw new Error(`Palette overrides must be "#rrggbb" hex; theme "${name}" has "${slot}": "${String(value)}".`);
    }
    palette[slot as ZshColorName] = value.toLowerCase();
  }
  const merged: Record<HazeThemeRole, ColorSpec> = {...purple.roles, ...spec.roles, ...overrides} as Record<HazeThemeRole, ColorSpec>;
  const resolved = {} as HazeTheme;
  for (const role of THEME_ROLES) resolved[role] = resolveColorSpec(String(merged[role] ?? ''), palette);
  return resolved;
}

/** The active theme instance; swap with `setActiveTheme` before rendering (and on future `/theme` switches). */
export let theme: HazeTheme = resolveTheme();

export function setActiveTheme(next: HazeTheme): void {
  theme = next;
}
