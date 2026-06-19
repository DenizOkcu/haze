import {stripAnsi as stripAnsiCodes} from './ansi.js';
import {commandMatches} from './command.js';

export type LineFilterDefinition = {
  name: string;
  matchCommand: RegExp | ((command: string) => boolean);
  stripAnsi?: boolean;
  replace?: Array<{pattern: RegExp; replacement: string}>;
  matchOutput?: RegExp;
  unless?: RegExp;
  stripLinesMatching?: RegExp[];
  keepLinesMatching?: RegExp[];
  truncateLinesAt?: number;
  headLines?: number;
  tailLines?: number;
  maxLines?: number;
  onEmpty?: string;
};

export type AppliedLineFilter = {
  text: string;
  filtered: boolean;
  warning?: string;
};

function matchesCommand(definition: LineFilterDefinition, command: string) {
  return commandMatches(command, definition.matchCommand);
}

function capLines(lines: string[], definition: LineFilterDefinition) {
  if (definition.headLines != null && lines.length > definition.headLines) {
    const omitted = lines.length - definition.headLines;
    return [...lines.slice(0, definition.headLines), `[... ${omitted} lines omitted ...]`];
  }
  if (definition.tailLines != null && lines.length > definition.tailLines) {
    const omitted = lines.length - definition.tailLines;
    return [`[... ${omitted} lines omitted ...]`, ...lines.slice(-definition.tailLines)];
  }
  if (definition.maxLines != null && lines.length > definition.maxLines) {
    const head = Math.ceil(definition.maxLines * 0.6);
    const tail = Math.max(0, definition.maxLines - head);
    const omitted = lines.length - definition.maxLines;
    return [...lines.slice(0, head), `[... ${omitted} lines omitted ...]`, ...lines.slice(lines.length - tail)];
  }
  return lines;
}

export function applyLineFilter(definition: LineFilterDefinition, command: string, text: string): AppliedLineFilter | undefined {
  if (!matchesCommand(definition, command)) return undefined;
  try {
    let next = text;
    if (definition.stripAnsi) next = stripAnsiCodes(next);
    for (const replacement of definition.replace ?? []) next = next.replace(replacement.pattern, replacement.replacement);

    const matched = definition.matchOutput?.test(next) ?? false;
    const vetoed = definition.unless?.test(next) ?? false;
    if (matched && !vetoed) return {text: definition.onEmpty ?? next, filtered: true};

    const hadTrailingNewline = /\r?\n$/.test(next);
    let lines = next.split(/\r?\n/);
    if (hadTrailingNewline) lines.pop();
    if (definition.stripLinesMatching?.length) {
      lines = lines.filter(line => !definition.stripLinesMatching?.some(pattern => pattern.test(line)));
    }
    if (definition.keepLinesMatching?.length) {
      lines = lines.filter(line => definition.keepLinesMatching?.some(pattern => pattern.test(line)));
    }
    if (definition.truncateLinesAt != null) {
      lines = lines.map(line => line.length > definition.truncateLinesAt! ? `${line.slice(0, definition.truncateLinesAt)}…` : line);
    }
    lines = capLines(lines, definition);
    next = lines.join('\n');
    if (!next.trim() && definition.onEmpty) next = definition.onEmpty;
    return {text: next, filtered: next !== text};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {text, filtered: false, warning: `line filter ${definition.name} failed: ${message}`};
  }
}

export function findLineFilter(definitions: LineFilterDefinition[], command: string) {
  return definitions.find(definition => matchesCommand(definition, command));
}
