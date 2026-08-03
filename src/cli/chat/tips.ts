/**
 * Rotating tips shown under the busy label while the model is thinking.
 *
 * The registry is data, not code, so rewording or pruning is trivial. Tips
 * must describe things the user can do from their keyboard (slash commands,
 * `@`-mentions, key presses, flags) — never internal model-tool mechanics
 * like how `readFile` pages or `grep` caps results. Keep one idea per entry,
 * lead with the action, and stay terminal-width-friendly.
 */
export const TIPS: readonly string[] = [
  'Attach an image with @path/to/img.png — or any path with / — png/jpg/jpeg/gif/webp.',
  'Type @ to browse workspace files; Tab completes the path.',
  'Mention any file or directory by @path (or paste a /-containing path) to let the model read it this turn, even outside the workspace.',
  'Backslash-escape spaces in paths: @screen\\ 2026.png works for macOS screenshots.',
  'Mark a provider image-capable in /provider so attached images actually get sent.',
  '/mcp add context7 loads external tools for up-to-date library docs.',
  '/lsp presets then /lsp add typescript enables jump-to-definition, references, and rename.',
  '/skills browses packaged workflows — skills inject instructions, never code.',
  '/init scaffolds an AGENTS.md so future sessions start with project context.',
  'Conversations persist under ~/.haze/sessions; resume the latest with /resume.',
  'Long threads compact automatically; /compact does it on demand.',
  '/fleet runs genuinely independent tasks through disposable contexts in parallel.',
  'Press esc to interrupt a running turn and reclaim control.',
  '/context shows a token breakdown — system, project context, tools, and messages.',
  '/model <name> sets a model directly (e.g. /model sonnet); selecting one also sets its provider.',
  '/tips toggles this hint line off if you find it distracting.',
];

/**
 * Pick a random tip index, avoiding the previous one when possible so the
 * rotation never shows the same tip twice in a row.
 */
export function randomTipIndex(exclude?: number): number {
  if (TIPS.length <= 1) return 0;
  let next = Math.floor(Math.random() * TIPS.length);
  while (next === exclude) next = Math.floor(Math.random() * TIPS.length);
  return next;
}

/** Whether the tips rotation is enabled in user settings (default true). */
export function tipsEnabled(settings: {tips?: {enabled?: boolean}}): boolean {
  return settings.tips?.enabled !== false;
}
