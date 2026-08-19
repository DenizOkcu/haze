import {describe, expect, it} from 'vitest';
import fs from 'fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  BUILT_IN_THEME_SPECS,
  DEFAULT_THEME_NAME,
  THEME_ROLES,
  ZSH_COLOR_NAMES,
  ZSH_NAMED_COLORS,
  resolveColorSpec,
  resolveTheme,
  xterm256Color,
} from '../../src/ui/theme.js';

const HEX = /^#[0-9a-f]{6}$/;

/** WCAG relative luminance, for the readability guard below. */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two resolved hex colors. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const THEMES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ui', 'themes');
const EXPECTED_THEMES = [
  'purple', 'light', 'af-magic', 'agnoster', 'bira', 'bureau', 'clean',
  'cloud', 'dst', 'fishy', 'robbyrussell', 'solarized-dark', 'solarized-light', 'steeef',
];

describe('zsh color vocabulary (oh-my-zsh parity)', () => {
  it('accepts exactly the zsh `colors` associative-array keys', () => {
    expect([...ZSH_COLOR_NAMES]).toEqual(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'default']);
    for (const name of ZSH_COLOR_NAMES) expect(ZSH_NAMED_COLORS[name]).toMatch(HEX);
  });

  it('resolves zsh color names ($fg[name]) through the terminal palette', () => {
    expect(resolveColorSpec('cyan')).toBe(ZSH_NAMED_COLORS.cyan);
    expect(resolveColorSpec('green')).toBe(ZSH_NAMED_COLORS.green);
  });

  it('resolves xterm-256 indices (${FG[nnn]} / %F{nnn}) for cube, grayscale, and base-16 slots', () => {
    expect(xterm256Color(0)).toBe(ZSH_NAMED_COLORS.black);
    expect(xterm256Color(9)).toBe('#ef2929'); // bright red
    expect(xterm256Color(16)).toBe('#000000');
    expect(xterm256Color(21)).toBe('#0000ff');
    expect(xterm256Color(105)).toBe('#8787ff'); // af-magic prompt char
    expect(xterm256Color(214)).toBe('#ffaf00'); // af-magic dirty marker
    expect(xterm256Color(237)).toBe('#3a3a3a'); // af-magic dashes
    expect(xterm256Color(232)).toBe('#080808');
    expect(xterm256Color(255)).toBe('#eeeeee');
    expect(resolveColorSpec('214')).toBe('#ffaf00');
  });

  it('passes truecolor hex through (%F{#rrggbb}), normalized', () => {
    expect(resolveColorSpec('#FF8800')).toBe('#ff8800');
    expect(resolveColorSpec('#a78bfa')).toBe('#a78bfa');
  });

  it('rejects unknown colors with the accepted vocabulary in the message', () => {
    expect(() => resolveColorSpec('purple')).toThrow(/zsh color name.*black.*cyan.*#ff8800/);
    expect(() => resolveColorSpec('256')).toThrow(/Unknown color "256"/);
    expect(() => resolveColorSpec('#12345')).toThrow(/Unknown color/);
  });
});

describe('theme registry', () => {
  it('registers exactly the expected themes', () => {
    expect(Object.keys(BUILT_IN_THEME_SPECS)).toEqual(EXPECTED_THEMES);
  });

  it('keeps one file per theme: folder contents match the registry (like omz themes/)', () => {
    const files = fs.readdirSync(THEMES_DIR)
      .filter(file => file.endsWith('.ts') && file !== 'index.ts')
      .map(file => path.basename(file, '.ts'))
      .sort();
    expect(files).toEqual([...EXPECTED_THEMES].sort());
  });

  it(`defaults to ${DEFAULT_THEME_NAME}`, () => {
    expect(DEFAULT_THEME_NAME).toBe('purple');
    expect(resolveTheme()).toEqual(resolveTheme('purple'));
  });

  it('pairs every foreground with its background readably (WCAG >= 3:1)', () => {
    // The theme owns BOTH terminal defaults (OSC 10 + 11), so its primary text
    // must be readable on its canvas — light themes dark text, dark themes light.
    for (const name of Object.keys(BUILT_IN_THEME_SPECS)) {
      const t = resolveTheme(name);
      expect(contrast(t.foreground, t.background), `${name}: ${t.foreground} on ${t.background}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('resolves every built-in theme to a complete #rrggbb palette', () => {
    for (const [name, spec] of Object.entries(BUILT_IN_THEME_SPECS)) {
      const resolved = resolveTheme(name);
      expect(THEME_ROLES.every(role => typeof resolved[role] === 'string' && HEX.test(resolved[role])), `${name} (${Object.keys(spec.roles ?? {}).length} roles)`).toBe(true);
    }
  });

  it('keeps the purple palette identical to the haze brand values', () => {
    expect(resolveTheme('purple')).toEqual({
      background: '#171127',
      accent: '#a78bfa', accentDim: '#6d28d9', border: '#6d28d9', info: '#60a5fa',
      muted: '#9ca3af', foreground: '#f0eef6', command: '#ffb86c', success: '#39ff14',
      successBg: '#14331f', danger: '#fb7185', dangerBg: '#3a1720', warning: '#fbbf24',
      surfaceBg: '#1f1633', codeBg: '#202124',
    });
  });

  it('throws an actionable error listing valid themes for unknown names', () => {
    expect(() => resolveTheme('pure')).toThrow(`Unknown theme name "pure". Valid themes: ${EXPECTED_THEMES.join(', ')}`);
  });

  it('applies role overrides (also in oh-my-zsh color vocabulary) on top of a theme', () => {
    expect(resolveTheme('purple', {accent: 'cyan'})).toEqual({...resolveTheme('purple'), accent: ZSH_NAMED_COLORS.cyan});
  });

  it('falls back to the purple theme for roles a spec omits', () => {
    expect(resolveTheme('robbyrussell').accent).not.toBe(resolveTheme('purple').accent);
  });

  it('applies spec palette overrides so ports can pin their host terminal palette', () => {
    const t = resolveTheme('agnoster');
    expect(t.accent).toBe('#859900'); // Solarized green, not the default Tango approximation
    expect(t.border).toBe('#303030'); // xterm-256 slot resolved independently
  });
});

describe('oh-my-zsh theme ports', () => {
  it('robbyrussell keeps its signature colors: green arrow, cyan cwd, blue git prefix, red branch, yellow dirty', () => {
    const t = resolveTheme('robbyrussell');
    expect(t.accent).toBe(ZSH_NAMED_COLORS.green);   // $fg_bold[green]➜
    expect(t.command).toBe(ZSH_NAMED_COLORS.cyan);   // $fg[cyan]%c
    expect(t.info).toBe(ZSH_NAMED_COLORS.blue);      // $fg_bold[blue]git:(
    expect(t.danger).toBe(ZSH_NAMED_COLORS.red);     // $fg[red]branch
    expect(t.warning).toBe(ZSH_NAMED_COLORS.yellow); // $fg[yellow]✗
  });

  it('af-magic resolves its numeric xterm-256 slots', () => {
    const t = resolveTheme('af-magic');
    expect(t.accent).toBe('#8787ff');  // ${FG[105]}
    expect(t.command).toBe('#0087d7'); // ${FG[032]}
    expect(t.warning).toBe('#ffaf00'); // ${FG[214]}
    expect(t.muted).toBe('#3a3a3a');   // ${FG[237]}
  });

  it('agnoster inherits its segment colors (green clean, blue dir, yellow dirty, red retval) over a Solarized palette', () => {
    const t = resolveTheme('agnoster');
    expect(t.accent).toBe('#859900');
    expect(t.command).toBe('#268bd2');
    expect(t.warning).toBe('#b58900');
    expect(t.danger).toBe('#dc322f');
    expect(t.info).toBe('#2aa198'); // AGNOSTER_STATUS_JOB_FG
    expect(t.background).toBe('#002b36'); // README's Solarized Dark base03 canvas
    expect(t.codeBg).toBe('#073642');     // base02 surfaces on that canvas
  });

  it('steeef resolves its 256-color branch slots (purple user, orange host, limegreen cwd, turquoise branch, hotpink untracked)', () => {
    const t = resolveTheme('steeef');
    expect(t.accent).toBe('#af5fff');  // %F{135}
    expect(t.warning).toBe('#d75f00'); // %F{166}
    expect(t.command).toBe('#87ff00'); // %F{118}
    expect(t.info).toBe('#5fd7ff');    // %F{81}
    expect(t.danger).toBe('#d7005f');  // %F{161}
  });

  it('bira, dst, clean, bureau keep their defining hues', () => {
    expect(resolveTheme('bira').accent).toBe(ZSH_NAMED_COLORS.green);      // $fg[green]%n@%m
    expect(resolveTheme('dst').accent).toBe(ZSH_NAMED_COLORS.magenta);     // $fg[magenta]%n
    expect(resolveTheme('clean').accent).toBe(ZSH_NAMED_COLORS.white);     // $fg_bold[white]%n
    expect(resolveTheme('bureau').accent).toBe(ZSH_NAMED_COLORS.green);    // $fg_bold[green]±
    expect(resolveTheme('bureau').command).toBe(ZSH_NAMED_COLORS.white);   // $fg_bold[white]%~
  });

  it('solarized dark/light share one accent palette and swap only the base tones', () => {
    const dark = resolveTheme('solarized-dark');
    const light = resolveTheme('solarized-light');
    // Same accent → role mapping in both modes (Solarized's design), one accent per role.
    for (const t of [dark, light]) {
      expect(t.accent).toBe('#268bd2');    // blue
      expect(t.accentDim).toBe('#6c71c4'); // violet
      expect(t.command).toBe('#b58900');   // yellow
      expect(t.info).toBe('#2aa198');      // cyan
      expect(t.success).toBe('#859900');   // green
      expect(t.warning).toBe('#cb4b16');   // orange
      expect(t.danger).toBe('#dc322f');    // red
    }
    // Dark mode: base0 body, base01 comments, base02 surfaces over base03 canvas.
    expect(dark.background).toBe('#002b36');
    expect(dark.foreground).toBe('#839496');
    expect(dark.muted).toBe('#586e75');
    expect(dark.codeBg).toBe('#073642');
    expect(dark.surfaceBg).toBe('#073642');
    // Light mode: full Solarized Light — base3 canvas, base00 body, base1 comments, base2 surfaces.
    expect(light.background).toBe('#fdf6e3');
    expect(light.foreground).toBe('#657b83');
    expect(light.muted).toBe('#93a1a1');
    expect(light.codeBg).toBe('#eee8d5');
    expect(light.surfaceBg).toBe('#eee8d5');
  });

  it('gives every omz dark port a near-black canvas one step under its surfaces', () => {
    for (const name of ['robbyrussell', 'af-magic', 'fishy', 'cloud', 'bira', 'dst', 'clean', 'bureau', 'steeef']) {
      expect(resolveTheme(name).background, name).toBe('#121212');
      expect(resolveTheme(name).surfaceBg, name).toBe('#1c1c1c'); // xterm-256 234
    }
  });
});
