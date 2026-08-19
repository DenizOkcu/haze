import type {HazeThemeSpec} from '../theme.js';
import {purple} from './purple.js';
import {light} from './light.js';
import {afMagic} from './af-magic.js';
import {agnoster} from './agnoster.js';
import {bira} from './bira.js';
import {bureau} from './bureau.js';
import {clean} from './clean.js';
import {cloud} from './cloud.js';
import {dst} from './dst.js';
import {fishy} from './fishy.js';
import {robbyrussell} from './robbyrussell.js';
import {solarizedDark} from './solarized-dark.js';
import {solarizedLight} from './solarized-light.js';
import {steeef} from './steeef.js';

/**
 * Every built-in theme, keyed by its settings name. Keys must equal their file
 * names (minus `.ts`), mirroring how oh-my-zsh discovers `themes/<name>.zsh-theme`
 * by `ZSH_THEME=<name>`; `tests/ui/theme.test.ts` enforces folder↔registry parity.
 * See AGENTS.md in this folder for how to add/convert themes.
 */
export const BUILT_IN_THEME_SPECS: Record<string, HazeThemeSpec> = {
  purple,
  light,
  'af-magic': afMagic,
  agnoster,
  bira,
  bureau,
  clean,
  cloud,
  dst,
  fishy,
  robbyrussell,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  steeef,
};
