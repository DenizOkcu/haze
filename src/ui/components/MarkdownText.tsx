import React from 'react';
import {Box, Text, useStdout} from 'ink';
import {marked, type Tokens} from 'marked';
import {highlight} from 'cli-highlight';
import stripAnsi from 'strip-ansi';
import {theme} from '../theme.js';

export function MarkdownText({content}: {content: string}) {
  const tokens = marked.lexer(content, {gfm: true, breaks: true});
  const {stdout} = useStdout();
  const width = Math.max(20, (stdout.columns ?? process.stdout.columns ?? 100) - 2);
  return <Box flexDirection="column">
    {tokens.map((token, index) => <MarkdownBlock key={index} token={token} width={width} />)}
  </Box>;
}

function MarkdownBlock({token, width}: {token: Tokens.Generic; width: number}) {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      return <HeadingBlock heading={heading} width={width} />;
    }
    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      return <Box marginBottom={1}><InlineMarkdown text={paragraph.text} /></Box>;
    }
    case 'text': {
      const text = token as Tokens.Text;
      return <InlineMarkdown text={text.text} />;
    }
    case 'space':
      return <Text> </Text>;
    case 'hr':
      return <Text color={theme.deepPurple}>────────────────────────────────────────</Text>;
    case 'blockquote': {
      const quote = token as Tokens.Blockquote;
      return <Box flexDirection="column" marginY={1}>
        {quote.text.split('\n').map((line, index) => <Text key={index} backgroundColor={theme.quoteBg}>{padAnsi(line || ' ', width)}</Text>)}
      </Box>;
    }
    case 'list': {
      const list = token as Tokens.List;
      return <Box flexDirection="column" marginBottom={1}>
        {list.items.map((item, index) => <Box key={index}>
          <Text color={theme.purple}>{list.ordered ? `${index + 1}. ` : '• '}</Text>
          <InlineMarkdown text={item.text.replace(/\n/g, ' ')} />
        </Box>)}
      </Box>;
    }
    case 'code': {
      const code = token as Tokens.Code;
      return <CodeBlock code={code.text} language={code.lang} width={width} />;
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
    <Text color={theme.violet} bold>{title}</Text>
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

function CodeBlock({code, language, width}: {code: string; language?: string; width: number}) {
  let rendered: string;
  try {
    rendered = highlight(code, {language: language || undefined, ignoreIllegals: true});
  } catch {
    rendered = code;
  }

  const lines = rendered.replace(/\n$/, '').split('\n');
  return <Box flexDirection="column" marginY={1}>
    {language ? <Text color={theme.muted} backgroundColor={theme.codeBg}>{padAnsi(language, width)}</Text> : null}
    {lines.map((line, index) => <Text key={index} backgroundColor={theme.codeBg}>{padAnsi(line || ' ', width)}</Text>)}
  </Box>;
}

function InlineMarkdown({text}: {text: string}) {
  const parts = tokenizeInline(text);
  return <Text>
    {parts.map((part, index) => {
      if (part.kind === 'code') return <Text key={index} color={theme.warning}>{part.text}</Text>;
      if (part.kind === 'strong') return <Text key={index} bold>{part.text}</Text>;
      if (part.kind === 'em') return <Text key={index} italic>{part.text}</Text>;
      if (part.kind === 'link') return <Text key={index} color={theme.violet}>{part.text}</Text>;
      return <Text key={index}>{part.text}</Text>;
    })}
  </Text>;
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
