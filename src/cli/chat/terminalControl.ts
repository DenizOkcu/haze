import {spawn} from 'node:child_process';

/**
 * Pure helpers for interactive child-process handoff via Ink 8's
 * `suspendTerminal`. Kept free of Ink/React imports so they stay testable.
 */

export interface EditorLaunch {
  command: string;
  args: string[];
}

/** Split an editor/pager executable and quoted arguments without invoking a shell. */
function parseTerminalCommand(raw: string): EditorLaunch | false {
  const parts = raw.match(/"([^"]+)"|'([^']+)'|(\S+)/g) ?? [];
  const words = parts.map(part => part.replace(/^["']|["']$/g, '')).filter(Boolean);
  const command = words[0];
  return command ? {command, args: words.slice(1)} : false;
}

/**
 * Resolve the editor command for an external `$EDITOR` compose. Follows the
 * common `VISUAL` over `EDITOR` precedence; `false` means the environment has
 * no editor configured. Composite EDITOR values (`code -w`, `vim -f`) are
 * split into a command and args so no shell is needed.
 */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): EditorLaunch | false {
  const raw = (env['VISUAL'] || env['EDITOR'] || '').trim();
  return parseTerminalCommand(raw);
}

/**
 * Resolve a pager for viewing long text: `$PAGER`, else `less` (POSIX) or
 * `more` (Windows). Returns undefined when the text plausibly fits one screen
 * and a pager would only add a keypress.
 */
export function resolvePager(text: string, terminalRows: number, env: NodeJS.ProcessEnv = process.env): {command: string; args: string[]} | undefined {
  if (text.split('\n').length <= Math.max(1, terminalRows - 1)) return undefined;
  const pager = env['PAGER']?.trim() || (process.platform === 'win32' ? 'more' : 'less');
  const launch = parseTerminalCommand(pager);
  if (!launch) return undefined;
  return launch.command === 'less' && launch.args.length === 0
    ? {command: launch.command, args: ['-R', '-X']} : launch;
}

/**
 * Run a child process while Ink has suspended the terminal (raw mode off,
 * child owns the TTY). Resolves with the exit code; rejects on spawn or
 * unexpected input-stream errors. Early pager closure (EPIPE) is normal. `stdinText` pipes text into the child (pager);
 * without it the child inherits the terminal stdin (editor).
 */
export function runSuspendedChild(launch: {command: string; args: string[]}, stdinText?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = stdinText == null
      ? spawn(launch.command, launch.args, {stdio: 'inherit'})
      : spawn(launch.command, launch.args, {stdio: ['pipe', 'inherit', 'inherit']});
    child.once('error', reject);
    child.once('close', code => resolve(code));
    if (stdinText != null && child.stdin) {
      // Quitting a pager can close its pipe while a large write is pending.
      // Stream errors are separate from the child's spawn error event.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin.end(stdinText);
    }
  });
}

// Ink-side wiring lives in chat.tsx via useApp(); this module deliberately
// stays React-free. The interactive hook is defined in terminalControlHook.tsx.

// --- Ink-side wiring (React, no JSX) -------------------------------------

import {useCallback} from 'react';
import {useApp, useIsScreenReaderEnabled, useWindowSize} from 'ink';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {randomUUID} from 'node:crypto';

/**
 * `suspendTerminal` affordances for ChatScreen: run a fullscreen child
 * ($EDITOR, pager) with the terminal handed over, then restore Ink state and
 * force a full redraw. `composeInEditor` returns the composed text (or
 * undefined when no editor is configured / nothing was typed); `viewInPager`
 * returns whether a pager actually ran.
 */
export function useTerminalControl() {
  const {suspendTerminal} = useApp();
  const {rows} = useWindowSize();
  const screenReader = useIsScreenReaderEnabled();

  const composeInEditor = useCallback(async (): Promise<string | undefined> => {
    const editor = resolveEditorCommand();
    if (editor === false) return undefined;
    const file = path.join(os.tmpdir(), `haze-compose-${randomUUID()}.md`);
    await fs.writeFile(file, '', 'utf8');
    try {
      await suspendTerminal(async () => {
        await runSuspendedChild({command: editor.command, args: [...editor.args, file]});
      });
      const text = (await fs.readFile(file, 'utf8')).trim();
      return text || undefined;
    } finally {
      await fs.remove(file).catch(() => undefined);
    }
  }, [suspendTerminal]);

  const viewInPager = useCallback(async (text: string): Promise<boolean> => {
    if (screenReader) return false;
    const pager = resolvePager(text, rows);
    if (!pager) return false;
    await suspendTerminal(async () => {
      await runSuspendedChild(pager, text);
    });
    return true;
  }, [rows, screenReader, suspendTerminal]);

  return {composeInEditor, viewInPager};
}
