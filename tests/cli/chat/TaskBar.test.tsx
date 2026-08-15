import React from 'react';
import {describe, expect, it} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {MAX_VISIBLE_TASKS, TaskBar} from '../../../src/cli/chat/TaskBar.js';
import type {Task} from '../../../src/core/tasks/taskStorage.js';

function makeTasks(count: number): Task[] {
  return Array.from({length: count}, (_, index) => ({
    id: `t-${index}`,
    title: `Task ${index + 1}`,
    status: index === 0 ? 'in_progress' as const : 'pending' as const,
  }));
}

describe('TaskBar live-region cap', () => {
  it('shows at most MAX_VISIBLE_TASKS when collapsed', () => {
    const {lastFrame} = render(<TaskBar tasks={makeTasks(8)} width={60} expanded={false} padding={0} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Task 1');
    expect(frame).not.toContain('Task 6');
    expect(frame).toContain('1 active, 7 pending');
  });

  it('caps expanded rows at maxRows and reports the remainder', () => {
    const {lastFrame} = render(<TaskBar tasks={makeTasks(9)} width={60} expanded padding={0} maxRows={6} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Task 6');
    expect(frame).not.toContain('Task 7');
    expect(frame).toContain('+3 more');
  });

  it('shows every task when expanded within maxRows', () => {
    const {lastFrame} = render(<TaskBar tasks={makeTasks(4)} width={60} expanded padding={0} maxRows={6} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Task 4');
    expect(frame).not.toContain('more (ctrl+o)');
  });
});
