import React from 'react';
import {Text} from 'ink';
import {theme} from '../../ui/theme.js';

/**
 * The static welcome paragraph under the header banner. A component (not a
 * module-level element) so `<Text color>` reads the active theme on every
 * render and live `/themes` switches repaint it.
 */
export function ChatHeaderSubtitle() {
  return (
    <Text>
      {'A minimal coding agent for your terminal.\n\nStart with chat. Turn repeated work into Markdown skills:\n'}
      <Text color={theme.command}>/skills</Text>
      {'  — create, enable, disable, validate, or remove skills.\n\nType '}
      <Text color={theme.command}>@</Text>
      {' to browse workspace files. To grant read-only access to a file or directory outside the workspace for this turn, mention a path containing '}
      <Text color={theme.command}>/</Text>
      {' (for example, '}
      <Text color={theme.command}>@../shared/file.ts</Text>
      {' or '}
      <Text color={theme.command}>/tmp/reference.md</Text>
      {').\n\nImage mentions require a vision-capable model. File edits and writes stay inside the workspace.\n\nhaze runs tool calls without confirmation gates. Supervise consequential work as you would any shell session.\n\nShape haze around your workflow as you go.\n\nUse '}
      <Text color={theme.command}>/help</Text>
      {' for commands.'}
    </Text>
  );
}
