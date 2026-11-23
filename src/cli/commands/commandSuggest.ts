import {COMMAND_HELP_ENTRIES} from './commandHelp.js';

/** Documented command names (the first token of each `/help` usage line) plus aliases that exist only as matchers. */
const COMMAND_NAMES: readonly string[] = [...new Set([...COMMAND_HELP_ENTRIES.map(entry => entry.usage.split(/[\s<[]/)[0] ?? ''), '/kit'])];

/** Levenshtein distance between two strings. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(current[rightIndex - 1]! + 1, previous[rightIndex]! + 1, previous[rightIndex - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Closest known command (case-insensitive) by edit distance, within about one edit per three characters and at least two. */
function suggestCommand(value: string): string | undefined {
  const typed = value.trim().split(/\s+/)[0]?.toLowerCase();
  if (!typed) return undefined;
  const maxDistance = Math.max(2, Math.floor(typed.length / 3));
  let best: {name: string; distance: number} | undefined;
  for (const name of COMMAND_NAMES) {
    const distance = editDistance(typed, name);
    if (!best || distance < best.distance) best = {name, distance};
  }
  return best && best.distance <= maxDistance ? best.name : undefined;
}

/** System message for an unrecognized slash command: the closest known command (when near) and a pointer to `/help`. */
export function unknownCommandMessage(value: string): string {
  const suggestion = suggestCommand(value);
  return `Unknown command: ${value}.${suggestion ? ` Did you mean ${suggestion}?` : ''} Run /help for the list.`;
}
