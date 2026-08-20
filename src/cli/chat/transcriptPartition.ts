import type {Message} from '../commands/streaming.js';
import {markdownRootChunks} from '../../ui/components/MarkdownText.js';

/**
 * Pure partitioning of the display transcript into append-only static output
 * and the active dynamic tail (see messages.tsx for the rendering side). Kept
 * free of React so the ordering rules are unit-testable in isolation.
 */

function messageKey(message: Message, index: number) {
  return message.id ?? `${index}-${message.role}-${message.text}`;
}

export type TranscriptStaticItem =
  | {kind: 'message'; key: string; message: Message}
  | {kind: 'assistant-markdown'; key: string; message: Message; content: string; first: boolean; final: boolean};

export type TranscriptStreamingItem = {key: string; message: Message; showHeader?: boolean};

function orderedDisplayMessages(messages: Message[]) {
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
