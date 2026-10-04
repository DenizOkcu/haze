import React, {createRef} from 'react';
import {Box, Static, Text, measureElement, type DOMElement} from 'ink';
import {expect, it, vi} from 'vitest';
import {DynamicFrame} from '../../../src/cli/chat/DynamicFrame.js';
import {partitionDisplayMessages} from '../../../src/cli/chat/transcriptPartition.js';
import type {Message} from '../../../src/cli/commands/streaming.js';
import {MessageView} from '../../../src/cli/chat/messages.js';
import {TextInput} from '../../../src/ui/components/TextInput.js';
import {inkHarness} from '../../inkHarness.js';

it('bounds real dynamic geometry with all panels, blocked settled messages, drafts and resizes', async () => {
  const ref = createRef<DOMElement>();
  const submit = vi.fn();
  const long = 'wrapped path /' + 'very-long-directory/'.repeat(30);
  function Fixture({columns, rows}: {columns: number; rows: number}) {
    const sections = {
      live: Array.from({length: 12}, (_, index) => <MessageView key={index} width={columns}
        message={{role: index % 2 ? 'system' : 'assistant', text: long, streaming: index === 0}} />),
      tasks: <Text>{Array.from({length: 30}, () => long).join('\n')}</Text>,
      queue: <Text>{long.repeat(4)}</Text>,
      activity: <Text>Press R to resume · {long}</Text>,
      debug: <Text>{long.repeat(10)}</Text>,
      status: <Text>{long}</Text>,
    };
    return <Box ref={ref} flexDirection="column"><DynamicFrame rows={rows} columns={columns} sections={sections}
      input={limits => <TextInput width={limits.width} inputRows={limits.inputRows} suggestionRows={limits.suggestionRows} onRowsChange={limits.onRowsChange}
        suggestions={Array.from({length: 20}, (_, index) => ({value: `choice-${index}`, description: long}))}
        suggestionMode="always" onSubmit={submit} />}/></Box>;
  }
  const fixture = inkHarness(<Fixture columns={80} rows={24} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('a\nb\nc\nd');
    await fixture.app.waitUntilRenderFlush();
    for (const [columns, rows] of [[80, 24], [40, 12], [20, 6], [10, 3], [1, 1], [80, 24]]) {
      fixture.stdout.resize(columns!, rows!);
      fixture.app.rerender(<Fixture columns={columns!} rows={rows!} />);
      await fixture.app.waitUntilRenderFlush();
      expect(ref.current).not.toBeNull();
      const metrics = measureElement(ref.current!);
      expect(metrics.height).toBeGreaterThan(0);
      expect(metrics.height).toBeLessThanOrEqual(Math.max(1, rows! - 1));
      expect(metrics.width).toBeLessThanOrEqual(columns!);
    }
    expect(fixture.stdout.writes.join('')).not.toContain('\x1b[3J');
  } finally { await fixture.close(); }
});

it('appends completed tools and assistant text without jumping to the viewport origin', async () => {
  const ref = createRef<DOMElement>();
  function Fixture({messages}: {messages: Message[]}) {
    const {staticItems, streamingItems} = partitionDisplayMessages(messages);
    return <Box flexDirection="column">
      <Static items={staticItems}>{item => <Text key={item.key}>
        {item.kind === 'assistant-markdown' ? item.content : item.message.text}
      </Text>}</Static>
      <Box ref={ref} flexDirection="column"><DynamicFrame rows={24} columns={80}
        sections={{
          live: streamingItems.length ? rows => {
            const displayed = streamingItems.slice(0, Math.floor(rows / 2));
            const itemRows = displayed.length ? Math.floor(rows / displayed.length) : 0;
            return displayed.map(item => <Box key={item.key} maxHeight={itemRows} flexShrink={0} overflow="hidden">
              <MessageView message={item.message} width={80} showHeader={item.showHeader} maxVisibleLines={itemRows - 1} />
            </Box>);
          } : undefined,
          activity: <Text>Working</Text>,
          status: <Text>Workspace</Text>,
        }} input={() => <Text>› draft</Text>} /></Box>
    </Box>;
  }
  const history: Message[] = Array.from({length: 40}, (_, index) => ({id: `history-${index}`, role: 'system', text: `record-${index}`}));
  const tool: Message = {id: 'tool', role: 'system', text: 'tool-running', streaming: true};
  const fixture = inkHarness(<Fixture messages={history} />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdout.writes.length = 0;
    const stages: Message[][] = [
      [...history, tool],
      [...history, tool, {id: 'second-tool', role: 'system', text: 'second-tool-running', streaming: true}],
      [...history, {...tool, text: Array.from({length: 60}, (_, index) => `tool-line-${index}`).join('\n')}],
      [...history, {...tool, text: 'tool-completed', streaming: false}],
      [...history, {...tool, text: 'tool-completed', streaming: false}, {id: 'reply', role: 'assistant', text: 'assistant-start', streaming: true}],
      [...history, {...tool, text: 'tool-completed', streaming: false}, {id: 'reply', role: 'assistant', text: 'assistant-finished', streaming: false}],
    ];
    for (const [index, messages] of stages.entries()) {
      fixture.app.rerender(<Fixture messages={messages} />);
      await fixture.app.waitUntilRenderFlush();
      const height = measureElement(ref.current!).height;
      expect(height).toBeLessThan(24);
      if (index === 0) expect(height).toBeLessThan(12);
    }
    const output = fixture.stdout.writes.join('');
    expect(output).not.toMatch(/\x1b\[(?:1;1)?H/);
    expect(output).not.toContain('\x1b[3J');
    expect(output).not.toContain('record-39');
    expect(output).not.toContain('Live preview');
    expect(output).not.toContain('full output preserved');
    expect(output.match(/tool-completed/g)).toHaveLength(1);
    expect(output.match(/assistant-finished/g)).toHaveLength(1);
    expect(output.indexOf('tool-completed')).toBeLessThan(output.indexOf('assistant-start'));
  } finally { await fixture.close(); }
});
