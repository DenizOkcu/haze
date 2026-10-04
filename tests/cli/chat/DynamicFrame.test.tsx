import React, {createRef} from 'react';
import {Box, Text, measureElement, type DOMElement} from 'ink';
import {expect, it, vi} from 'vitest';
import {DynamicFrame} from '../../../src/cli/chat/DynamicFrame.js';
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
      expect(metrics.height).toBeLessThanOrEqual(rows!);
      expect(metrics.width).toBeLessThanOrEqual(columns!);
    }
    expect(fixture.stdout.writes.join('')).not.toContain('\x1b[3J');
  } finally { await fixture.close(); }
});
