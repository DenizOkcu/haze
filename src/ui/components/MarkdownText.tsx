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
      return <Box marginTop={heading.depth <= 2 ? 1 : 0}><Text color={theme.purple} bold>{'#'.repeat(heading.depth)} <InlineMarkdown text={heading.text} /></Text></Box>;
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
      return <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.violet}>{table.header.map(cell => stripInline(cell.text)).join(' | ')}</Text>
        <Text color={theme.deepPurple}>{table.header.map(() => '---').join(' | ')}</Text>
        {table.rows.map((row, index) => <Text key={index}>{row.map(cell => stripInline(cell.text)).join(' | ')}</Text>)}
      </Box>;
    }
    default:
      return <Text>{'raw' in token ? String(token.raw) : ''}</Text>;
  }
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

function stripInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function padAnsi(value: string, width: number): string {
  const visible = stripAnsi(value).length;
  return visible >= width ? value : value + ' '.repeat(width - visible);
}
