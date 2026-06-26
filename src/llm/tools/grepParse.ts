export type GrepMatchItem = {file: string; line: number; content: string; isContext: boolean};

type RgEvent = {type?: string; data?: {path?: {text?: string}; line_number?: number; lines?: {text?: string}}};

export type ParsedGrepOutput = {
  matches: GrepMatchItem[];
  totalMatches: number;
  returnedMatches: number;
  omittedMatches: number;
};

function isContextEvent(event: RgEvent): boolean {
  return event.type === 'context';
}

function isMatchEvent(event: RgEvent): boolean {
  return event.type === 'match';
}

function extractMatchItem(event: RgEvent): GrepMatchItem | undefined {
  const file = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  const content = event.data?.lines?.text?.replace(/\r?\n$/, '');
  if (!file || lineNumber == null || content == null) return undefined;
  return {file, line: lineNumber, content, isContext: isMatchEvent(event) ? false : true};
}

export function parseRipgrepJsonStream(stdout: string, maxMatches: number, contextLines: number, toRelativePath: (absolute: string) => string = value => value): ParsedGrepOutput {
  if (!stdout) return {matches: [], totalMatches: 0, returnedMatches: 0, omittedMatches: 0};
  const lines = stdout.split('\n').filter(Boolean);
  const matches: GrepMatchItem[] = [];
  let totalMatches = 0;
  let returnedMatches = 0;
  let omittedMatches = 0;
  let pendingContext: GrepMatchItem[] = [];
  let retainFollowingContext = false;
  for (const line of lines) {
    let event: RgEvent;
    try {
      event = JSON.parse(line) as RgEvent;
    } catch {
      continue;
    }
    if (event.type === 'begin' || event.type === 'end') {
      pendingContext = [];
      retainFollowingContext = false;
      continue;
    }
    if (!isContextEvent(event) && !isMatchEvent(event)) continue;
    const item = extractMatchItem(event);
    if (!item) continue;
    const relative = {...item, file: toRelativePath(item.file)};
    if (isContextEvent(event)) {
      if (retainFollowingContext) {
        matches.push(relative);
        continue;
      }
      pendingContext.push(relative);
      if (pendingContext.length > contextLines) pendingContext.shift();
      continue;
    }
    totalMatches += 1;
    if (returnedMatches >= maxMatches) {
      omittedMatches += 1;
      pendingContext = [];
      retainFollowingContext = false;
      continue;
    }
    matches.push(...pendingContext, relative);
    returnedMatches += 1;
    pendingContext = [];
    retainFollowingContext = true;
  }
  return {matches, totalMatches, returnedMatches, omittedMatches};
}