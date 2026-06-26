import React from 'react';
import {Box, Text} from 'ink';
import type {Task, TaskStatus} from '../../core/tasks/taskStorage.js';
import {theme} from '../../ui/theme.js';

const TASK_STATUS_ICON: Record<TaskStatus, string> = {
  pending: '\u25CB',
  in_progress: '\u25D0',
  completed: '\u2713',
};

function taskStatusColor(status: TaskStatus): string {
  switch (status) {
    case 'completed': return theme.success;
    case 'in_progress': return theme.warning;
    default: return theme.muted;
  }
}

export const MAX_VISIBLE_TASKS = 5;

export function TaskBar({tasks, width, expanded, padding}: {tasks: Task[]; width: number; expanded: boolean; padding: number}) {
  const maxTitleWidth = Math.max(10, width - 6);
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const pending = tasks.filter(t => t.status === 'pending');
  const completed = tasks.filter(t => t.status === 'completed');
  const limit = expanded ? tasks.length : MAX_VISIBLE_TASKS;
  const ordered: Task[] = [];
  for (const t of inProgress) { if (ordered.length < limit) ordered.push(t); }
  for (const t of pending) { if (ordered.length < limit) ordered.push(t); }
  for (let i = completed.length - 1; i >= 0 && ordered.length < limit; i--) {
    ordered.push(completed[i]!);
  }
  const counts = `${inProgress.length > 0 ? `${inProgress.length} active` : ''}${pending.length > 0 ? `${inProgress.length > 0 ? ', ' : ''}${pending.length} pending` : ''}${completed.length > 0 ? `${inProgress.length + pending.length > 0 ? ', ' : ''}${completed.length} done` : ''}`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {padding > 0 && Array.from({length: padding}, (_, i) => <Text key={`pad-${i}`}>{' '}</Text>)}
      <Text><Text color={theme.purple} bold>Tasks</Text>{counts ? <Text color={theme.muted}> ({counts})</Text> : null}{tasks.length > MAX_VISIBLE_TASKS ? <Text color={theme.muted} dimColor> · ctrl+o {expanded ? 'collapse' : 'expand'}</Text> : null}</Text>
      {ordered.map(task => {
        const title = task.title.length > maxTitleWidth ? task.title.slice(0, maxTitleWidth - 1) + '\u2026' : task.title;
        return (
          <Text key={task.id} wrap="truncate-end">
            <Text color={taskStatusColor(task.status)}>{TASK_STATUS_ICON[task.status]} </Text>
            <Text color={task.status === 'completed' ? theme.muted : 'white'}>{title}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
