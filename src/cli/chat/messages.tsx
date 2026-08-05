import React from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import type {Message} from '../commands/streaming.js';
import {formatElapsedTime, formatElapsedTimeWhole} from '../commands/formatters.js';
import {MarkdownText} from '../../ui/components/MarkdownText.js';
import {isSubstantiveAssistantText} from '../commands/streaming/assistantText.js';
import {theme} from '../../ui/theme.js';

function fullWidthLines(text: string, width: number, leftPadding = 0) {
  const safeWidth = Math.max(1, width);
  const prefix = ' '.repeat(leftPadding);
  return text.replace(/\r\n|\r/g, '\n').split('\n').map(line => `${prefix}${line}`.padEnd(Math.max(safeWidth, line.length + leftPadding)));
}

function fullWidthBlankLine(width: number) {
  return ''.padEnd(Math.max(1, width));
}

/** Slash commands in system text are highlighted like `code` in the docs site. A command name never contains `/`, which keeps absolute paths like `/Users/...` plain. */
const SLASH_COMMAND_PATTERN = /(^|(?<=\s))\/[a-zA-Z][a-zA-Z0-9-]*(?![\w/-])/g;

function slashCommandParts(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(SLASH_COMMAND_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    parts.push(<Text key={`cmd-${index}`} color={theme.command}>{match[0]}</Text>);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/**
 * Style one line of a system message: single-token list items that look like
 * paths are orange, short leading "Key:" prefixes are bold, and slash
 * commands are orange everywhere.
 */
function systemLineContent(line: string): React.ReactNode {
  const fileItem = /^- (\S+)$/.exec(line);
  if (fileItem && /[./]/.test(fileItem[1] ?? '')) return <Text color={theme.command}>{line}</Text>;
  const colonIndex = line.indexOf(':');
  if (colonIndex > 0 && colonIndex <= 30) {
    const key = line.slice(0, colonIndex);
    if ((key.startsWith('- ') || key.includes(' ')) && /^[A-Za-z][\w ./~-]*$/.test(key.replace(/^- /, ''))) {
      return <React.Fragment><Text bold>{key}</Text>{slashCommandParts(line.slice(colonIndex))}</React.Fragment>;
    }
  }
  return slashCommandParts(line);
}

function SystemMessageText({text}: {text: string}) {
  return <Text>
    {text.split('\n').map((line, index) => <React.Fragment key={index}>{index > 0 ? '\n' : null}{systemLineContent(line)}</React.Fragment>)}
  </Text>;
}

function ToolMessageText({text, streaming}: {text: string; streaming?: boolean}) {
  const lines = text.split('\n');
  return <Box flexDirection="column">
    {lines.map((line, index) => {
      const diffRow = /^(\s*\d+\s+)([+-])(.*)$/.exec(line);
      if (diffRow) {
        const [, prefix, marker, rest] = diffRow;
        const isAdd = marker === '+';
        return <Text key={`${index}-${line}`} color={theme.foreground} backgroundColor={isAdd ? theme.successBg : theme.dangerBg}>
          <Text color={isAdd ? theme.success : theme.danger} backgroundColor={isAdd ? theme.successBg : theme.dangerBg}>{prefix}{marker}</Text>{rest}
        </Text>;
      }
      const contextRow = /^(\s*\d+\s+)\s(.*)$/.exec(line);
      if (contextRow) {
        const [, prefix, rest] = contextRow;
        return <Text key={`${index}-${line}`} color={theme.foreground}>
          <Text color={theme.muted}>{prefix} </Text>{rest}
        </Text>;
      }
      const row = /^(\s*)([✓✗…])\s+(\S+)(.*)$/.exec(line);
      if (!row) {
        const timer = /(.*) (\([0-9]+(?:h [0-9]+m [0-9]+(?:\.[0-9])?s|m [0-9]+(?:\.[0-9])?s|(?:\.[0-9])?s)\))$/.exec(line);
        return <Text key={`${index}-${line}`} color={theme.muted}>
          {index === 0 && streaming ? <><Spinner type="dots" /> </> : null}{timer ? timer[1] : line}{timer ? <Text color={theme.muted} bold={false}> {timer[2]}</Text> : null}
        </Text>;
      }
      const [, indent, icon, toolName, rest] = row;
      const iconColor = icon === '✓' ? theme.success : icon === '✗' ? theme.danger : theme.muted;
      const timer = /(.*) (\([0-9]+(?:h [0-9]+m [0-9]+(?:\.[0-9])?s|m [0-9]+(?:\.[0-9])?s|(?:\.[0-9])?s)\))$/.exec(rest);
      return <Text key={`${index}-${line}`} color={theme.muted}>
        {indent}<Text color={iconColor}>{icon}</Text> <Text color={theme.purple}>{toolName}</Text>{timer ? timer[1] : rest}{timer ? <Text color={theme.muted} bold={false}> {timer[2]}</Text> : null}
      </Text>;
    })}
  </Box>;
}

export function messageElapsedLabel(message: Message) {
  if (message.startedAt == null) return '';
  if (message.role === 'assistant' && !message.streaming && !isSubstantiveAssistantText(message.text)) return '';
  const end = message.finishedAt ?? (message.streaming ? Date.now() : message.startedAt);
  const elapsed = end - message.startedAt;
  if (message.role === 'assistant' && !message.streaming && message.tokensPerSecond != null) {
    return `✓ Done in ${formatElapsedTime(elapsed)} · ${Math.round(message.tokensPerSecond)} tok/s`;
  }
  return message.streaming ? formatElapsedTimeWhole(elapsed) : formatElapsedTime(elapsed);
}

export function MessageView({message, width}: {message: Message; width: number}) {
  if (message.role === 'user') {
    return <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor={theme.surfaceBg}>{fullWidthBlankLine(width)}</Text>
      <Text color={theme.success} bold backgroundColor={theme.surfaceBg}>{'  You asked'.padEnd(width)}</Text>
      {fullWidthLines(message.text, width, 2).map((line, lineIndex) => <Text key={lineIndex} color={theme.foreground} backgroundColor={theme.surfaceBg}>{line}</Text>)}
      <Text backgroundColor={theme.surfaceBg}>{fullWidthBlankLine(width)}</Text>
    </Box>;
  }

  return <Box flexDirection="column" marginBottom={1}>
    <Text>
      <Text color={message.role === 'assistant' ? theme.purple : message.role === 'tool' ? theme.blue : message.role === 'system' ? theme.success : theme.muted} bold>{message.role === 'assistant' ? 'haze' : message.role === 'tool' ? 'Tool' : 'Info'}</Text>
      {messageElapsedLabel(message) ? <Text color={theme.muted} bold={false}> · {messageElapsedLabel(message)}</Text> : null}
    </Text>
    {message.role === 'tool'
      ? <ToolMessageText text={message.text} streaming={message.streaming} />
      : message.role === 'assistant' && !message.streaming
        ? <MarkdownText content={message.text} width={width} />
        : message.role === 'system'
          ? <SystemMessageText text={message.text} />
          : <Text>{message.text}</Text>}
  </Box>;
}

export function messageKey(message: Message, index: number) {
  return message.id ?? `${index}-${message.role}-${message.text}`;
}

export function orderedDisplayMessages(messages: Message[]) {
  return messages
    .map((message, index) => ({message, index}))
    .sort((a, b) => {
      if (a.message.displayOrder != null && b.message.displayOrder != null && a.message.displayOrder !== b.message.displayOrder) {
        return a.message.displayOrder - b.message.displayOrder;
      }
      return a.index - b.index;
    })
    .map(item => item.message);
}
