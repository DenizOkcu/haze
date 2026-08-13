import React from 'react';
import {Box, Text} from 'ink';
import {marked, type Tokens} from 'marked';
import stripAnsi from 'strip-ansi';
import {theme} from '../theme.js';
import {highlightedCodeLine} from '../codeHighlight.js';

const MARKED_OPTIONS = {gfm: true, breaks: true} as const;

export const MarkdownText = React.memo(function MarkdownText({content, width}: {content: string; width: number}) {
  const tokens = marked.lexer(content, MARKED_OPTIONS);
  const contentWidth = Math.max(20, width - 2);
  return <Box flexDirection="column">
    {tokens.map((token, index) => {
      const codeLead = token.type === 'paragraph' || token.type === 'text' ? codeLeadForFollowingFence(tokens, index) : undefined;
      if (token.type === 'space' && bridgesCodeLeadToFence(tokens, index)) return null;
      return <MarkdownBlock
        key={index}
        token={token}
        width={contentWidth}
        source={token.type === 'code' ? precedingCodeSource(tokens, index) : undefined}
        textOverride={codeLead?.text}
        compactAfter={codeLead != null}
      />;
    })}
  </Box>;
});

type CodeSource = {path: string; startLine: number};

/**
 * Bounded LRU cache for Markdown root chunking (RH-007). Settled assistant
 * messages never change, but `partitionDisplayMessages` runs on every render
 * and would otherwise re-lex the entire historical transcript each time. The
 * chunking is a pure function of the source text, so identical content reuses a
 * cached result; the LRU bound keeps memory predictable for long sessions.
 */
const ROOT_CHUNKS_CACHE_MAX = 500;
const rootChunksCache = new Map<string, string[]>();

/** Test-only: clear the chunk cache to assert lexer call counts deterministically. */
export function clearMarkdownRootChunksCacheForTests(): void {
  rootChunksCache.clear();
}

function computeMarkdownRootChunks(content: string): string[] {
  const tokens = marked.lexer(content, MARKED_OPTIONS);
  if (tokens.length === 0) return content ? [content] : [];

  const chunks: string[] = [];
  let chunkStart = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.type === 'space') continue;

    let nextIndex = index + 1;
    while (tokens[nextIndex]?.type === 'space') nextIndex++;
    if (nextIndex >= tokens.length) continue;

    const linkedCodeBlock = (token.type === 'paragraph' || token.type === 'text')
      && tokens[nextIndex]?.type === 'code'
      && codeLeadForFollowingFence(tokens, index) != null;
    if (linkedCodeBlock) continue;

    const chunk = tokens.slice(chunkStart, nextIndex).map(item => item.raw).join('');
    if (chunk) chunks.push(chunk);
    chunkStart = nextIndex;
  }

  const activeChunk = tokens.slice(chunkStart).map(token => token.raw).join('');
  if (activeChunk) chunks.push(activeChunk);
  return chunks;
}

/**
 * Split Markdown into stable root-level chunks. The final chunk is deliberately
 * considered active: Marked may still reclassify it as more text arrives (for
 * example, a paragraph can become a setext heading or a GFM table). Once a
 * following root block exists, the preceding chunk is safe to render once in
 * Ink's <Static> transcript.
 *
 * A source-path lead and its following fenced code block stay in one chunk so
 * MarkdownText can preserve their shared filename and starting line metadata.
 */
export function markdownRootChunks(content: string): string[] {
  const cached = rootChunksCache.get(content);
  if (cached) {
    rootChunksCache.delete(content);
    rootChunksCache.set(content, cached);
    return cached;
  }
  const chunks = computeMarkdownRootChunks(content);
  if (rootChunksCache.size >= ROOT_CHUNKS_CACHE_MAX) {
    const oldest = rootChunksCache.keys().next().value;
    if (oldest !== undefined) rootChunksCache.delete(oldest);
  }
  rootChunksCache.set(content, chunks);
  return chunks;
}

function MarkdownBlock({token, width, source, textOverride, compactAfter}: {
  token: Tokens.Generic;
  width: number;
  source?: CodeSource;
  textOverride?: string;
  compactAfter?: boolean;
}) {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      return <HeadingBlock heading={heading} width={width} />;
    }
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      return <Box marginBottom={compactAfter ? 0 : 1}><InlineMarkdown text={textOverride ?? paragraph.text} /></Box>;
    }
    case 'text': {
      const text = token as Tokens.Text;
      return <InlineMarkdown text={textOverride ?? text.text} />;
    }
    case 'space':
      return <Text> </Text>;
    case 'hr':
      return <Text color={theme.deepPurple}>────────────────────────────────────────</Text>;
    case 'blockquote': {
      const quote = token as Tokens.Blockquote;
      return <Box flexDirection="column" marginY={1}>
        {quote.text.split('\n').map((line, index) => <Text key={index} backgroundColor={theme.surfaceBg}>{padAnsi(line || ' ', width)}</Text>)}
      </Box>;
    }
    case 'list': {
      const list = token as Tokens.List;
      return <Box flexDirection="column" marginBottom={1}>
        {list.items.map((item, index) => (
          <ListItemView key={index} item={item} ordered={list.ordered} index={index} width={width} />
        ))}
      </Box>;
    }
    case 'code': {
      const code = token as Tokens.Code;
      const fence = parseCodeFenceInfo(code.lang);
      return <CodeBlock code={code.text} language={fence.language} source={fence.source ?? source} width={width} />;
    }
    case 'table': {
      const table = token as Tokens.Table;
      const lines = renderMarkdownTable(table, width);
      return <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, index) => <TableLine key={index} line={line} />)}
      </Box>;
    }
    default:
      return <Text>{'raw' in token ? String(token.raw) : ''}</Text>;
  }
}

function ListItemView({item, ordered, index, width}: {
  item: Tokens.ListItem;
  ordered: boolean | undefined;
  index: number;
  width: number;
}) {
  const marker = ordered ? `${index + 1}. ` : '• ';
  const markerWidth = visibleLength(marker);
  const blocks = (item.tokens ?? []).filter(child => child.type !== 'space');
  if (blocks.length === 0) {
    return <Box><Text color={theme.purple}>{marker}</Text></Box>;
  }
  return <Box flexDirection="column">
    {blocks.map((block, blockIndex) => (
      <ListItemBlock
        key={blockIndex}
        token={block}
        marker={blockIndex === 0 ? marker : null}
        markerWidth={markerWidth}
        width={width}
      />
    ))}
  </Box>;
}

function ListItemBlock({token, marker, markerWidth, width}: {
  token: Tokens.Generic;
  marker: string | null;
  markerWidth: number;
  width: number;
}) {
  if (token.type === 'paragraph' || token.type === 'text') {
    const text = (token as Tokens.Paragraph | Tokens.Text).text;
    // Pre-wrap manually. Ink's auto-wrap algorithm injects a stray leading
    // space on wrapped lines at certain widths (the wrap-point whitespace gets
    // preserved on top of the marker indent), so we hand-pack atoms into lines
    // and render each line as its own row. Whitespace is preserved as separate
    // "space" atoms so the original spacing (e.g. "code, code") survives.
    const contentWidth = Math.max(1, width - markerWidth);
    const lines = wrapInlineAtoms(splitInlineIntoAtoms(tokenizeInline(text)), contentWidth);
    const prefix = (lineIndex: number) => lineIndex === 0 ? (marker ?? ' '.repeat(markerWidth)) : ' '.repeat(markerWidth);
    return <Box flexDirection="column">
      {lines.map((line, lineIndex) => (
        <Box key={lineIndex} flexDirection="row">
          <Box flexShrink={0}><Text color={theme.purple}>{prefix(lineIndex)}</Text></Box>
          <Text>{line.map((atom, atomIndex) => atom.type === 'space' ? <Text key={atomIndex}>{' '}</Text> : renderInlinePart(atom, atomIndex))}</Text>
        </Box>
      ))}
    </Box>;
  }
  // Block-level content (code, nested list, blockquote, table). The marker
  // sits on its own line when this is the first block; the block then renders
  // indented to align with the marker.
  return <Box flexDirection="column">
    {marker ? <Text color={theme.purple}>{marker}</Text> : null}
    <Box flexDirection="column" marginLeft={markerWidth}>
      <MarkdownBlock token={token} width={Math.max(20, width - markerWidth)} />
    </Box>
  </Box>;
}

function HeadingBlock({heading, width}: {heading: Tokens.Heading; width: number}) {
  const title = stripInline(heading.text).trim();
  if (heading.depth === 1) return <Box flexDirection="column" marginTop={1} marginBottom={1}>
    <Text color={theme.purple} bold>{title.toUpperCase()}</Text>
    <Text color={theme.deepPurple}>{'─'.repeat(Math.min(width, Math.max(12, visibleLength(title))))}</Text>
  </Box>;
  if (heading.depth === 2) return <Box marginTop={1} marginBottom={1}>
    <Text color={theme.purple} bold>{title}</Text>
  </Box>;
  return <Box marginTop={heading.depth <= 3 ? 1 : 0}>
    <Text color={theme.purple} bold>{title}</Text>
  </Box>;
}

function TableLine({line}: {line: string}) {
  if (isTableBorder(line)) return <Text color={theme.deepPurple}>{line}</Text>;
  return <Text>
    {[...line].map((char, index) => char === '│'
      ? <Text key={index} color={theme.deepPurple}>{char}</Text>
      : <Text key={index}>{char}</Text>)}
  </Text>;
}

function CodeBlock({code, language, source, width}: {code: string; language?: string; source?: CodeSource; width: number}) {
  const lines = code.replace(/\n$/, '').split('\n');
  const firstLine = source?.startLine ?? 1;
  const showLineNumbers = source != null || lines.length > 1;
  const lineNumberWidth = String(firstLine + lines.length - 1).length;
  const header = source ? `${source.path}:${source.startLine}${language ? ` · ${language}` : ''}` : language;
  return <Box flexDirection="column" marginTop={source ? 0 : 1} marginBottom={1}>
    {header ? <Text color={source ? theme.command : theme.muted} backgroundColor={theme.codeBg}>{padAnsi(header, width)}</Text> : null}
    {lines.map((line, index) => {
      const lineNumber = firstLine + index;
      const prefix = showLineNumbers ? `${String(lineNumber).padStart(lineNumberWidth)} │ ` : '';
      const rendered = highlightedCodeLine(line, Math.max(1, width - prefix.length), language);
      return <Text key={index} backgroundColor={theme.codeBg}>
        {prefix ? <Text color={theme.muted} backgroundColor={theme.codeBg}>{prefix}</Text> : null}{rendered}
      </Text>;
    })}
  </Box>;
}

function parseCodeSource(value: string): CodeSource | undefined {
  const match = /((?:[A-Za-z]:)?[^\s`()]+?\.[A-Za-z0-9]+):([1-9]\d*)(?:-[1-9]\d*)?[).,;:]?$/.exec(stripInline(value).trim());
  if (!match) return undefined;
  return {path: match[1], startLine: Number(match[2])};
}

function precedingCodeSource(tokens: readonly Tokens.Generic[], codeIndex: number): CodeSource | undefined {
  for (let index = codeIndex - 1; index >= 0; index--) {
    const token = tokens[index];
    if (!token || token.type === 'space') continue;
    if (token.type !== 'paragraph' && token.type !== 'text') return undefined;
    return parseCodeSource((token as Tokens.Paragraph | Tokens.Text).text);
  }
  return undefined;
}

function codeLeadForFollowingFence(tokens: readonly Tokens.Generic[], leadIndex: number): {source: CodeSource; text: string} | undefined {
  const token = tokens[leadIndex];
  if (!token || (token.type !== 'paragraph' && token.type !== 'text')) return undefined;
  const value = (token as Tokens.Paragraph | Tokens.Text).text;
  const source = parseCodeSource(value);
  if (!source) return undefined;
  let nextIndex = leadIndex + 1;
  while (tokens[nextIndex]?.type === 'space') nextIndex++;
  if (tokens[nextIndex]?.type !== 'code') return undefined;
  const pathIndex = value.lastIndexOf(source.path);
  const text = value.slice(0, pathIndex).replace(/\s*(?:—|–|-)\s*`?\s*$/, '').trimEnd();
  return {source, text};
}

function bridgesCodeLeadToFence(tokens: readonly Tokens.Generic[], spaceIndex: number): boolean {
  let previousIndex = spaceIndex - 1;
  while (tokens[previousIndex]?.type === 'space') previousIndex--;
  let nextIndex = spaceIndex + 1;
  while (tokens[nextIndex]?.type === 'space') nextIndex++;
  return codeLeadForFollowingFence(tokens, previousIndex) != null && tokens[nextIndex]?.type === 'code';
}

function parseCodeFenceInfo(info?: string): {language?: string; source?: CodeSource} {
  const parts = info?.trim().split(/\s+/).filter(Boolean) ?? [];
  const firstSource = parts.findIndex(part => parseCodeSource(part) != null);
  if (firstSource === -1) return {language: parts[0]};
  return {
    language: firstSource === 0 ? undefined : parts[0],
    source: parseCodeSource(parts[firstSource]),
  };
}

function InlineMarkdown({text}: {text: string}) {
  const parts = tokenizeInline(text);
  return <Text>{parts.map((part, index) => renderInlinePart(part, index))}</Text>;
}

function renderInlinePart(part: {kind: 'text' | 'code' | 'strong' | 'em' | 'link'; text: string}, index: number | string) {
  if (part.kind === 'code') return <Text key={index} color={theme.warning} backgroundColor={theme.codeBg}>{part.text}</Text>;
  if (part.kind === 'strong') return <Text key={index} bold>{part.text}</Text>;
  if (part.kind === 'em') return <Text key={index} italic>{part.text}</Text>;
  if (part.kind === 'link') return <Text key={index} color={theme.purple}>{part.text}</Text>;
  return <Text key={index}>{part.text}</Text>;
}

type InlineKind = 'text' | 'code' | 'strong' | 'em' | 'link';
type InlineAtom = {type: 'word'; kind: InlineKind; text: string} | {type: 'space'};

function splitInlineIntoAtoms(parts: {kind: InlineKind; text: string}[]): InlineAtom[] {
  const atoms: InlineAtom[] = [];
  for (const part of parts) {
    for (const piece of part.text.split(/(\s+)/)) {
      if (piece === '') continue;
      if (/^\s+$/.test(piece)) atoms.push({type: 'space'});
      else atoms.push({type: 'word', kind: part.kind, text: piece});
    }
  }
  return atoms;
}

function wrapInlineAtoms(atoms: InlineAtom[], maxWidth: number): InlineAtom[][] {
  const lines: InlineAtom[][] = [];
  let line: InlineAtom[] = [];
  let width = 0;
  const flushLine = () => {
    while (line.length > 0 && line[line.length - 1].type === 'space') line.pop();
    if (line.length > 0) lines.push(line);
    line = [];
    width = 0;
  };
  for (const atom of atoms) {
    if (atom.type === 'space') {
      if (width > 0) {
        line.push(atom);
        width += 1;
      }
      continue;
    }
    const wordWidth = visibleLength(atom.text);
    if (wordWidth > maxWidth && width === 0) {
      // Overlong word on its own line: keep it whole so we don't pretend to
      // have wrap behavior we can't actually render.
      lines.push([atom]);
      line = [];
      width = 0;
      continue;
    }
    if (width > 0 && width + wordWidth > maxWidth) flushLine();
    line.push(atom);
    width += wordWidth;
  }
  flushLine();
  return lines.length > 0 ? lines : [[]];
}

function tokenizeInline(text: string): {kind: 'text' | 'code' | 'strong' | 'em' | 'link'; text: string}[] {
  const out: {kind: 'text' | 'code' | 'strong' | 'em' | 'link'; text: string}[] = [];
  const regex = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > last) out.push({kind: 'text', text: text.slice(last, match.index)});
    if (match[1]) out.push({kind: 'code', text: match[1]});
    else if (match[2]) out.push({kind: 'strong', text: match[2]});
    else if (match[3]) out.push({kind: 'em', text: match[3]});
    else if (match[4]) out.push({kind: 'link', text: `${match[4]} (${match[5]})`});
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({kind: 'text', text: text.slice(last)});
  return out;
}

type TableAlign = 'center' | 'left' | 'right' | null;

export function renderMarkdownTable(table: Tokens.Table, maxWidth?: number): string[] {
  const rows = [table.header, ...table.rows].map(row => row.map(cell => normalizeTableCell(cell.text)));
  const columnCount = Math.max(table.header.length, ...table.rows.map(row => row.length), 0);
  const widths = tableColumnWidths(rows, columnCount, maxWidth);
  const aligns = Array.from({length: columnCount}, (_, column) => table.align[column] ?? null);

  const border = (left: string, separator: string, right: string) => `${left}${widths.map(width => '─'.repeat(width + 2)).join(separator)}${right}`;
  const rowLines = (row: string[], isHeader = false) => {
    const wrappedCells = widths.map((width, column) => wrapTableCell(row[column] ?? '', width));
    const height = Math.max(1, ...wrappedCells.map(cell => cell.length));
    return Array.from({length: height}, (_, line) => `│${widths.map((width, column) => {
      const align = isHeader ? null : aligns[column];
      return ` ${alignCell(wrappedCells[column]?.[line] ?? '', width, align)} `;
    }).join('│')}│`);
  };

  return [
    border('┌', '┬', '┐'),
    ...rowLines(rows[0] ?? [], true),
    border('├', '┼', '┤'),
    ...rows.slice(1).flatMap(row => rowLines(row)),
    border('└', '┴', '┘'),
  ];
}

function tableColumnWidths(rows: string[][], columnCount: number, maxWidth?: number): number[] {
  const naturalWidths = Array.from({length: columnCount}, (_, column) => Math.max(3, ...rows.map(row => visibleLength(row[column] ?? ''))));
  if (!maxWidth) return naturalWidths;

  const contentBudget = Math.max(columnCount, maxWidth - (columnCount * 3 + 1));
  if (naturalWidths.reduce((sum, width) => sum + width, 0) <= contentBudget) return naturalWidths;

  const minWidths = naturalWidths.map(width => Math.min(3, width));
  const widths = [...naturalWidths];
  while (widths.reduce((sum, width) => sum + width, 0) > contentBudget) {
    let widest = -1;
    for (let index = 0; index < widths.length; index++) {
      if (widths[index] > minWidths[index] && (widest === -1 || widths[index] > widths[widest])) widest = index;
    }
    if (widest === -1) break;
    widths[widest]--;
  }
  return widths;
}

function wrapTableCell(text: string, width: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let current = '';
  const flush = () => {
    lines.push(current);
    current = '';
  };

  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (!current && visibleLength(word) > width) {
      for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (visibleLength(next) <= width) current = next;
    else {
      flush();
      if (visibleLength(word) > width) {
        for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
      } else {
        current = word;
      }
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

function isTableBorder(line: string): boolean {
  return line.startsWith('┌') || line.startsWith('├') || line.startsWith('└');
}

function normalizeTableCell(text: string): string {
  return stripInline(text).replace(/\s+/g, ' ').trim();
}

function alignCell(value: string, width: number, align: TableAlign): string {
  const padding = Math.max(0, width - visibleLength(value));
  if (align === 'right') return `${' '.repeat(padding)}${value}`;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${value}${' '.repeat(padding - left)}`;
  }
  return `${value}${' '.repeat(padding)}`;
}

function stripInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function padAnsi(value: string, width: number): string {
  const visible = visibleLength(value);
  return visible >= width ? value : value + ' '.repeat(width - visible);
}
