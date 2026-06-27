import {describe, expect, it} from 'vitest';
import {createToolGroupRenderer} from '../../src/cli/commands/streaming/toolGroupRenderer.js';

describe('tool group caption', () => {
  it('renders a caption set before the first tool call', () => {
    const messages: Record<string, string> = {};
    const renderer = createToolGroupRenderer({
      addMessage: msg => { messages[msg.id] = msg.text; },
      updateMessage: (id, update) => { if (update.text != null) messages[id] = update.text; },
      debugLog: () => {},
    });
    renderer.setGroupCaption('Let me read the config');
    renderer.ensureToolItem({toolCallId: 't1', toolName: 'readFile', input: {path: 'a.ts'}});
    renderer.stopToolTimer();
    const rendered = Object.values(messages).join('\n');
    expect(rendered).toContain('Let me read the config');
  });
});
