import React from 'react';
import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import type {Message} from '../commands/streaming.js';
import type {ToolDisplayDiff, ToolDisplayDiffLine} from '../commands/streaming/toolGroupRenderer.js';
import {formatElapsedTime, formatElapsedTimeWhole} from '../commands/formatters.js';
import {MarkdownText, markdownRootChunks} from '../../ui/components/MarkdownText.js';
import {isSubstantiveAssistantText} from '../commands/streaming/assistantText.js';
import {theme} from '../../ui/theme.js';
import {highlightedCodeLine, languageForPath} from '../../ui/codeHighlight.js';

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
    // Exclude `/` and `.` from the key body so URLs like `https://example.com:443`
    // don't match as a "Key:" prefix and get bolded as one span (which would
    // bypass the slash-command highlighter for anything that follows).
    if ((key.startsWith('- ') || key.includes(' ')) && /^[A-Za-z][\w ~-]*$/.test(key.replace(/^- /, ''))) {
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

function diffLineNumber(line: ToolDisplayDiffLine) {
  return line.type === 'remove' ? line.oldLine : line.newLine ?? line.oldLine;
}

function ToolDiffView({diff, width}: {diff: ToolDisplayDiff; width: number}) {
  const contentWidth = Math.max(1, width - 2);
  const lineNumberWidth = Math.max(4, ...diff.lines.map(line => String(diffLineNumber(line) ?? '').length));
  return <Box flexDirection="column" marginLeft={2} marginTop={1}>
    <Text color={theme.muted}>⎿ <Text color={theme.command}>{diff.path}</Text> · Added {diff.addedLines} line{diff.addedLines === 1 ? '' : 's'}, removed {diff.removedLines} line{diff.removedLines === 1 ? '' : 's'}</Text>
    {diff.lines.map((line, index) => {
      const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      const lineNumber = `${String(diffLineNumber(line) ?? '').padStart(lineNumberWidth)} `;
      const markerPrefix = `${marker} `;
      const prefixWidth = lineNumber.length + markerPrefix.length;
      const code = highlightedCodeLine(line.text, Math.max(1, contentWidth - prefixWidth), languageForPath(diff.path));
      if (line.type === 'context') {
        return <Box key={`${diff.id}-${index}`} flexDirection="row">
          <Text color={theme.muted}>{lineNumber}{markerPrefix}</Text><Text>{code}</Text>
        </Box>;
      }
      const isAdd = line.type === 'add';
      const backgroundColor = isAdd ? theme.successBg : theme.dangerBg;
      return <Box key={`${diff.id}-${index}`} flexDirection="row">
        <Text color={theme.muted}>{lineNumber}</Text>
        <Text color={theme.foreground} backgroundColor={backgroundColor}>
          <Text color={isAdd ? theme.success : theme.danger} backgroundColor={backgroundColor}>{markerPrefix}</Text>{code}
        </Text>
      </Box>;
    })}
  </Box>;
}

function ToolMessageText({text, streaming, width, toolDiffs}: {text: string; streaming?: boolean; width: number; toolDiffs?: ToolDisplayDiff[]}) {
  const lines = text.split('\n');
  return <Box flexDirection="column">
    {lines.map((line, index) => {
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
    {toolDiffs?.map(diff => <ToolDiffView key={diff.id} diff={diff} width={width} />)}
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

export const AssistantMarkdownChunkView = React.memo(function AssistantMarkdownChunkView({message, content, width, first, final}: {
  message: Message;
  content: string;
  width: number;
  first: boolean;
  final: boolean;
}) {
  const completion = final ? messageElapsedLabel(message) : '';
  return <Box flexDirection="column" marginBottom={final ? 1 : 0}>
    {first ? <Text color={theme.purple} bold>haze</Text> : null}
    <MarkdownText content={content} width={width} />
    {completion ? <Text color={theme.muted}>{completion}</Text> : null}
  </Box>;
});

export const MessageView = React.memo(function MessageView({message, width, showHeader = true}: {message: Message; width: number; showHeader?: boolean}) {
  if (message.role === 'user') {
    return <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor={theme.surfaceBg}>{fullWidthBlankLine(width)}</Text>
      <Text color={theme.success} bold backgroundColor={theme.surfaceBg}>{'  You asked'.padEnd(width)}</Text>
      {fullWidthLines(message.text, width, 2).map((line, lineIndex) => <Text key={lineIndex} color={theme.foreground} backgroundColor={theme.surfaceBg}>{line}</Text>)}
      <Text backgroundColor={theme.surfaceBg}>{fullWidthBlankLine(width)}</Text>
    </Box>;
  }

  return <Box flexDirection="column" marginBottom={1}>
    {showHeader ? <Text>
      <Text color={message.role === 'assistant' ? theme.purple : message.role === 'tool' ? theme.blue : message.role === 'system' ? theme.success : theme.muted} bold>{message.role === 'assistant' ? 'haze' : message.role === 'tool' ? 'Tool' : 'Info'}</Text>
      {messageElapsedLabel(message) ? <Text color={theme.muted} bold={false}> · {messageElapsedLabel(message)}</Text> : null}
    </Text> : null}
    {message.role === 'tool'
      ? <ToolMessageText text={message.text} streaming={message.streaming} width={width} toolDiffs={message.toolDiffs} />
      : message.role === 'assistant' && !message.streaming
        // Only settled assistant messages get Markdown rendering. Streaming
        // text re-tokenizes on every delta (expensive) and the partial Markdown
        // would flicker; user text stays plain to keep pasted Markdown literal.
        ? <MarkdownText content={message.text} width={width} />
        : message.role === 'system'
          ? <SystemMessageText text={message.text} />
          : <Text>{message.text}</Text>}
  </Box>;
});

export function messageKey(message: Message, index: number) {
  return message.id ?? `${index}-${message.role}-${message.text}`;
}

export type TranscriptStaticItem =
  | {kind: 'message'; key: string; message: Message}
  | {kind: 'assistant-markdown'; key: string; message: Message; content: string; first: boolean; final: boolean};

export type TranscriptStreamingItem = {key: string; message: Message; showHeader?: boolean};

/** Partition display messages into append-only static Markdown roots and the active streaming tail. */
export function partitionDisplayMessages(messages: Message[]): {staticItems: TranscriptStaticItem[]; streamingItems: TranscriptStreamingItem[]} {
  const staticItems: TranscriptStaticItem[] = [];
  const streamingItems: TranscriptStreamingItem[] = [];
  let reachedDynamicTail = false;
  orderedDisplayMessages(messages).forEach((message, index) => {
    const key = messageKey(message, index);
    // Static output must remain an ordered prefix. A settled notification that
    // follows live text stays in the dynamic frame until that text is complete.
    if (reachedDynamicTail) {
      streamingItems.push({key, message});
      return;
    }
    if (message.role !== 'assistant') {
      if (message.streaming) {
        reachedDynamicTail = true;
        streamingItems.push({key, message});
      } else {
        staticItems.push({kind: 'message', key, message});
      }
      return;
    }

    const chunks = markdownRootChunks(message.text);
    if (chunks.length === 0) {
      if (message.streaming) {
        reachedDynamicTail = true;
        streamingItems.push({key, message});
      } else {
        staticItems.push({kind: 'message', key, message});
      }
      return;
    }

    // Marked may still reclassify the final root while the stream grows. Keep
    // only that root dynamic; every preceding root is now safe to append once.
    const staticChunkCount = message.streaming ? Math.max(0, chunks.length - 1) : chunks.length;
    for (let chunkIndex = 0; chunkIndex < staticChunkCount; chunkIndex++) {
      staticItems.push({
        kind: 'assistant-markdown',
        key: `${key}-markdown-${chunkIndex}`,
        message,
        content: chunks[chunkIndex] ?? '',
        first: chunkIndex === 0,
        final: !message.streaming && chunkIndex === chunks.length - 1,
      });
    }
    if (message.streaming) {
      reachedDynamicTail = true;
      streamingItems.push({
        key,
        message: {...message, text: chunks.at(-1) ?? message.text},
        showHeader: staticChunkCount === 0,
      });
    }
  });
  return {staticItems, streamingItems};
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
