const COMMAND_SEPARATORS = /\s*(?:&&|\|\||;|\|)\s*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const WRAPPER_COMMANDS = new Set(['sudo', 'command', 'env', 'time', 'nohup']);

function shellWords(segment: string) {
  return segment.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) ?? [];
}

function unquote(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function stripWrapperWords(words: string[]) {
  let index = 0;
  while (index < words.length) {
    const word = unquote(words[index] ?? '');
    if (ASSIGNMENT.test(word)) {
      index += 1;
      continue;
    }
    if (word === 'env') {
      index += 1;
      while (index < words.length) {
        const envWord = unquote(words[index] ?? '');
        if (envWord === '-u') index += 2;
        else if (envWord.startsWith('-')) index += 1;
        else if (ASSIGNMENT.test(envWord)) index += 1;
        else break;
      }
      continue;
    }
    if (word === 'sudo') {
      index += 1;
      while (index < words.length && unquote(words[index] ?? '').startsWith('-')) index += 1;
      continue;
    }
    if (WRAPPER_COMMANDS.has(word)) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index).join(' ');
}

export function commandCandidates(command: string) {
  const rawSegments = command.split(COMMAND_SEPARATORS).map(segment => segment.trim()).filter(Boolean);
  const candidates = new Set<string>([command.trim()]);
  for (const segment of rawSegments) {
    candidates.add(segment);
    const normalized = stripWrapperWords(shellWords(segment)).trim();
    if (normalized) candidates.add(normalized);
  }
  return [...candidates].filter(Boolean);
}

export function commandMatches(command: string, matcher: RegExp | ((command: string) => boolean)) {
  return commandCandidates(command).some(candidate => typeof matcher === 'function' ? matcher(candidate) : matcher.test(candidate));
}
