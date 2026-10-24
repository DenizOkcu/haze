import hljs from 'highlight.js/lib/common';
import {cellWidth, clipCells} from './textGeometry.js';

/**
 * Terminal code highlighting on top of highlight.js directly (the common
 * language bundle). highlight.js emits HTML spans; we render those spans as
 * 24-bit ANSI sequences through a fixed palette below, so no highlight-to-
 * terminal library sits between us and the parser.
 */

/** Terminal style for one highlight.js scope. */
interface ScopeStyle {
  color?: readonly [number, number, number];
  bold?: boolean;
  italic?: boolean;
}

/** Fixed palette (One Dark-like, medium brightness for any background). */
const THEME: Record<string, ScopeStyle> = {
  addition: {color: [0x98, 0xc3, 0x79]},
  attribute: {color: [0xe0, 0x6c, 0x75]},
  attr: {color: [0xe0, 0x6c, 0x75]},
  'built_in': {color: [0xe5, 0xc0, 0x7b]},
  bullet: {color: [0xd1, 0x9a, 0x66]},
  class: {color: [0xe5, 0xc0, 0x7b]},
  comment: {color: [0x8b, 0x94, 0x9e], italic: true},
  deletion: {color: [0xe0, 0x6c, 0x75]},
  doctag: {color: [0x8b, 0x94, 0x9e], italic: true},
  emphasis: {italic: true},
  escape: {color: [0x98, 0xc3, 0x79]},
  formula: {color: [0x98, 0xc3, 0x79]},
  function: {color: [0x61, 0xaf, 0xef]},
  keyword: {color: [0xc6, 0x78, 0xdd]},
  link: {color: [0x61, 0xaf, 0xef]},
  literal: {color: [0xd1, 0x9a, 0x66]},
  meta: {color: [0x61, 0xaf, 0xef]},
  name: {color: [0xe0, 0x6c, 0x75]},
  number: {color: [0xd1, 0x9a, 0x66]},
  params: {},
  property: {color: [0xe0, 0x6c, 0x75]},
  quote: {color: [0x8b, 0x94, 0x9e], italic: true},
  regexp: {color: [0x56, 0xb6, 0xc2]},
  section: {color: [0x61, 0xaf, 0xef], bold: true},
  'selector-tag': {color: [0xe0, 0x6c, 0x75]},
  string: {color: [0x98, 0xc3, 0x79]},
  strong: {bold: true},
  subst: {},
  symbol: {color: [0xd1, 0x9a, 0x66]},
  tag: {color: [0xe0, 0x6c, 0x75]},
  'template-variable': {color: [0xd1, 0x9a, 0x66]},
  title: {color: [0x61, 0xaf, 0xef]},
  type: {color: [0xe5, 0xc0, 0x7b]},
  variable: {color: [0xd1, 0x9a, 0x66]},
};

/** Decode the entity set highlight.js escapes code text into. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sgrStart(style: ScopeStyle): string {
  const parts: string[] = [];
  if (style.bold) parts.push('1');
  if (style.italic) parts.push('3');
  if (style.color) parts.push(`38;2;${style.color[0]};${style.color[1]};${style.color[2]}`);
  return parts.length > 0 ? `\x1b[${parts.join(';')}m` : '';
}

/**
 * Resolve the style for text inside `frames` (one token array per open span).
 * The innermost frame wins; within a frame the rightmost token wins because
 * highlight.js writes the most specific scope last (`title function_`).
 */
function resolveStyle(frames: string[][]): ScopeStyle | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const tokens = frames[i];
    for (let t = tokens.length - 1; t >= 0; t--) {
      const style = THEME[tokens[t]];
      if (style && (style.color !== undefined || style.bold || style.italic)) return style;
    }
  }
  return undefined;
}

/** Render highlight.js span HTML to ANSI-styled text. */
function renderToAnsi(html: string): string {
  const frames: string[][] = [];
  let out = '';
  const tags = /<span class="([^"]*)">|<\/span>|([^<]+)|</g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    if (match[0] === '</span>') {
      frames.pop();
    } else if (match[0].startsWith('<span')) {
      frames.push(
        (match[1] ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map(token => token.replace(/^hljs-/, '').replace(/_$/, '')),
      );
    } else if (match[2] !== undefined) {
      const text = decodeEntities(match[2]);
      const style = resolveStyle(frames);
      out += style ? `${sgrStart(style)}${text}\x1b[0m` : text;
    } else {
      // A bare `<` that is not part of a span tag (only possible in malformed
      // input); keep it so displayed text never silently loses characters.
      out += '<';
    }
  }
  return out;
}

/** Map a source path to a highlight.js language when its extension is known. */
export function languageForPath(filePath: string) {
  const extension = /\.([^./]+)$/.exec(filePath)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  const aliases: Record<string, string> = {
    cjs: 'javascript', cts: 'typescript', htm: 'html', js: 'javascript', md: 'markdown', mjs: 'javascript',
    mts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', ts: 'typescript', yml: 'yaml',
  };
  const language = aliases[extension] ?? extension;
  return hljs.getLanguage(language) ? language : undefined;
}

/** Highlight, clip, and pad one source line to an exact terminal width. */
export function highlightedCodeLine(code: string, width: number, language?: string) {
  const safeWidth = Math.max(1, width);
  const singleLine = code.replace(/\t/g, '  ');
  const fitted = cellWidth(singleLine) > safeWidth
    ? `${clipCells(singleLine, safeWidth - 1)}…`
    : singleLine;
  let rendered = fitted;
  try {
    if (language && hljs.getLanguage(language)) {
      rendered = renderToAnsi(hljs.highlight(fitted, {language, ignoreIllegals: true}).value);
    } else if (!language) {
      rendered = renderToAnsi(hljs.highlightAuto(fitted).value);
    }
  } catch {
    // Unknown or malformed source still renders as plain text.
  }
  const padding = Math.max(0, safeWidth - cellWidth(rendered));
  return `${rendered}${' '.repeat(padding)}`;
}
