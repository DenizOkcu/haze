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

function ToolMessageText({text, streaming}: {text: string; streaming?: boolean}) {
  const lines = text.split('\n');
  return <Box flexDirection="column">
    {lines.map((line, index) => {
      const diffRow = /^(\s*\d+\s+)([+-])(.*)$/.exec(line);
      if (diffRow) {
        const [, prefix, marker, rest] = diffRow;
        const isAdd = marker === '+';
        return <Text key={`${index}-${line}`} color="white" backgroundColor={isAdd ? theme.successBg : theme.dangerBg}>
          <Text color={isAdd ? theme.success : theme.danger} backgroundColor={isAdd ? theme.successBg : theme.dangerBg}>{prefix}{marker}</Text>{rest}
        </Text>;
      }
      const contextRow = /^(\s*\d+\s+)\s(.*)$/.exec(line);
      if (contextRow) {
        const [, prefix, rest] = contextRow;
        return <Text key={`${index}-${line}`} color="white">
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
      <Text backgroundColor={theme.quoteBg}>{fullWidthBlankLine(width)}</Text>
      <Text color={theme.success} bold backgroundColor={theme.quoteBg}>{'  You asked'.padEnd(width)}</Text>
      {fullWidthLines(message.text, width, 2).map((line, lineIndex) => <Text key={lineIndex} color="white" backgroundColor={theme.quoteBg}>{line}</Text>)}
      <Text backgroundColor={theme.quoteBg}>{fullWidthBlankLine(width)}</Text>
    </Box>;
  }

  return <Box flexDirection="column" marginBottom={1}>
    <Text>
      <Text color={message.role === 'assistant' ? theme.purple : message.role === 'tool' ? theme.blue : theme.muted} bold>{message.role === 'assistant' ? 'haze' : message.role === 'tool' ? 'Tool' : 'Info'}</Text>
      {messageElapsedLabel(message) ? <Text color={theme.muted} bold={false}> · {messageElapsedLabel(message)}</Text> : null}
    </Text>
    {message.role === 'tool'
      ? <ToolMessageText text={message.text} streaming={message.streaming} />
      : message.role === 'assistant' && !message.streaming
        ? <MarkdownText content={message.text} />
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
