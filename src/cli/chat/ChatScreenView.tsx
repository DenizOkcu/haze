import React from 'react';
import {Box, Static, Text} from 'ink';
import {ActivitySpinner, StatusNotice} from '../../ui/components/NativeIndicators.js';
import {Header} from '../../ui/components/Header.js';
import {TextInput} from '../../ui/components/TextInput.js';
import {theme} from '../../ui/theme.js';
import type {Task} from '../../core/tasks/taskStorage.js';
import {TaskBar} from './TaskBar.js';
import {BusyBar} from './BusyBar.js';
import {DynamicFrame} from './DynamicFrame.js';
import {AssistantMarkdownChunkView, MessageView} from './messages.js';
import {partitionDisplayMessages, type TranscriptStaticItem} from './transcriptPartition.js';
import {LiveTail} from './LiveTail.js';
import {contextLeftLabel, statusBarMetrics} from './chatMetrics.js';
import {inputSuggestionsForState} from './inputSuggestions.js';
import {fileMentionSuggestions} from './fileMentionSuggestions.js';
import {TIPS} from './tips.js';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, type Mode} from '../commands/chatModes.js';
import type {TokenUsage} from '../commands/streaming/turnRuntime.js';
import type {useFollowUpQueue} from './followUpQueue.js';
import {formatTokenCount} from '../../utils/format.js';
import type {PausedResume} from './screenDeps.js';
import type {ContextUsage} from './turnState.js';

export type ChatStaticItem = {kind: 'header'; key: string; subtitle: React.ReactNode} | TranscriptStaticItem;

/**
 * The pure render of the chat screen: static transcript plus the dynamic
 * frame. Extracted from `commands/chat.tsx` so the component file stays
 * orchestration glue; every value arrives as an explicit prop.
 */
export function ChatScreenView(props: {
  version: string | undefined;
  debug: boolean;
  terminalRows: number;
  horizontalPadding: number;
  contentWidth: number;
  /** Settled-width identity for the transcript replay: the Static key and the width its Markdown is laid out at. */
  replay: {key: string; contentWidth: number};
  staticItems: ChatStaticItem[];
  streamingItems: ReturnType<typeof partitionDisplayMessages>['streamingItems'];
  debugLogs: string[];
  metrics: ReturnType<typeof statusBarMetrics>;
  renderMetricsReader: (() => {at: number; renderTime: number} | undefined) | undefined;
  tokenUsage: TokenUsage;
  contextUsage: ContextUsage;
  followUps: ReturnType<typeof useFollowUpQueue>;
  visibleTasks: Task[];
  tasksExpanded: boolean;
  taskBarPadding: number;
  busy: boolean;
  busyLabel: string;
  busyElapsed: string;
  busyDetail: string | undefined;
  showingTip: boolean;
  tipIndex: number;
  graphBuilding: boolean;
  pausedResume: PausedResume | undefined;
  workspaceLabel: string;
  activeModelName: string;
  reasoningSuffix: string;
  placeholder: string;
  mode: Mode;
  inputHistory: string[];
  inputSuggestions: ReturnType<typeof inputSuggestionsForState>;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
  onResumeKey: (() => void) | undefined;
  onInterrupt: () => void;
  onEscape: () => void;
  onHistoryAdd: (value: string) => void;
  onToggleTasks: () => void;
}) {
  const {
    version, debug, terminalRows, horizontalPadding, contentWidth, replay, staticItems, streamingItems,
    debugLogs, metrics, renderMetricsReader, tokenUsage, contextUsage, followUps, visibleTasks, tasksExpanded,
    taskBarPadding, busy, busyLabel, busyElapsed, busyDetail,
    showingTip, tipIndex, graphBuilding, pausedResume, workspaceLabel, activeModelName, reasoningSuffix,
    placeholder, mode, inputHistory, inputSuggestions, onSubmit, onCancel, onResumeKey, onInterrupt,
    onEscape, onHistoryAdd, onToggleTasks,
  } = props;
  const contextLabel = contextLeftLabel(contextUsage, metrics.effectiveInput);
  return <Box flexDirection="column" paddingX={horizontalPadding}>
    {/* Replay settled history with fresh Markdown layout after the resize clear.
        Only Static remounts: input drafts and active turns keep their state. */}
    <Static key={replay.key} items={staticItems}>
      {item => item.kind === 'header'
        ? <Header key={item.key} subtitle={item.subtitle} version={version} />
        : item.kind === 'assistant-markdown'
          ? <AssistantMarkdownChunkView key={item.key} message={item.message} content={item.content} width={replay.contentWidth} first={item.first} final={item.final} />
          : <MessageView key={item.key} message={item.message} width={replay.contentWidth} />}
    </Static>
    <DynamicFrame rows={terminalRows} columns={contentWidth} sections={{
      live: streamingItems.length > 0 ? rows => <LiveTail items={streamingItems} width={contentWidth} rows={rows} /> : undefined,
      debug: debug ? <>
        {debugLogs.map((line, index) => <Text key={index} color={theme.muted} wrap="truncate-end">• {line}</Text>)}
        {metrics.hasTokenBreakdown && <Text color={theme.muted} wrap="truncate-end">Tokens: in={formatTokenCount(metrics.effectiveInput)} out={formatTokenCount(metrics.effectiveOutput)} logical={formatTokenCount(tokenUsage.logicalInputEstimate)}</Text>}
        {renderMetricsReader && (() => {
          const renderMetrics = renderMetricsReader();
          if (!renderMetrics) return null;
          const age = Date.now() - renderMetrics.at;
          // Skip the reading once it is clearly stale; it refreshes on the
          // next frame while anything animated keeps the debug panel alive.
          return age < 5_000 ? <Text color={theme.muted} wrap="truncate-end">Ink render: {renderMetrics.renderTime.toFixed(1)}ms</Text> : null;
        })()}
      </> : undefined,
      queue: followUps.queued.length > 0 ? <>
        <Text color={theme.muted} wrap="truncate-end">Queued follow-ups: {followUps.queued.length}</Text>
        {followUps.queued.map((item, index) => <Text key={`${index}-${item}`} color={theme.muted} wrap="truncate-end">{index + 1}. {item}</Text>)}
      </> : undefined,
      tasks: visibleTasks.length > 0 ? <TaskBar tasks={visibleTasks} width={contentWidth} expanded={tasksExpanded} padding={taskBarPadding} maxRows={Math.max(1, terminalRows - 8)} /> : undefined,
      activity: busy ? <BusyBar label={busyLabel} elapsed={busyElapsed} detail={busyDetail} tip={showingTip ? TIPS[tipIndex] : undefined} />
        : graphBuilding ? <Box overflow="hidden"><ActivitySpinner /><Box flexShrink={0} width={1} /><Text color={theme.muted} wrap="truncate-end">Building code graph in the background…</Text></Box>
        : pausedResume ? <StatusNotice variant="warning">Press R to resume · unfinished goal paused{pausedResume.pauseReason ? ` (${pausedResume.pauseReason})` : ''}</StatusNotice> : undefined,
      status: <>
        <Box width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <Text color={theme.muted} wrap="truncate-end">{workspaceLabel}</Text>
          <Text color={theme.muted} wrap="truncate-start">{activeModelName}{reasoningSuffix}</Text>
        </Box>
        <Box width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <Text color={theme.muted} wrap="truncate-end">{metrics.statusDetailLabel}</Text>
          {contextLabel && <Text color={theme.muted} wrap="truncate-start">{contextLabel}</Text>}
        </Box>
      </>,
    }} input={({width: inputWidth, inputRows, suggestionRows, onRowsChange}) => <TextInput
      placeholder={placeholder}
      disabled={busy && mode !== 'chat'}
      mask={MASKED_MODES.has(mode)}
      historyItems={inputHistory}
      recordHistory={mode === 'chat'}
      suggestions={inputSuggestions}
      suggestionMode={PICKER_MODES.has(mode) ? 'always' : 'slash'}
      submitOnEmpty={SUBMIT_EMPTY_MODES.has(mode)}
      width={inputWidth}
      inputRows={inputRows}
      suggestionRows={suggestionRows}
      onRowsChange={onRowsChange}
      getMentionSuggestions={fileMentionSuggestions}
      onHistoryAdd={onHistoryAdd}
      onToggleTasks={onToggleTasks}
      onCancel={onCancel}
      onResumeKey={onResumeKey}
      onInterrupt={onInterrupt}
      onEscape={onEscape}
      onSubmit={onSubmit}
    />} />
  </Box>;
}
