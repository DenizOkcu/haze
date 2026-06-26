import {describe, expect, it} from 'vitest';
import {parseRipgrepJsonStream} from '../../src/llm/tools/grepParse.js';

function event(type: 'begin' | 'match' | 'context' | 'end', file: string, line: number, text: string) {
  return JSON.stringify({type, data: {path: {text: file}, line_number: line, lines: {text: `${text}\n`}}});
}

describe('parseRipgrepJsonStream', () => {
  it('returns empty result for empty stdout', () => {
    expect(parseRipgrepJsonStream('', 50, 2)).toEqual({matches: [], totalMatches: 0, returnedMatches: 0, omittedMatches: 0});
  });

  it('counts matches and caps returned matches', () => {
    const stdout = [
      event('begin', '/repo/a.ts', 0, ''),
      event('match', '/repo/a.ts', 1, 'needle'),
      event('match', '/repo/a.ts', 3, 'needle'),
      event('end', '/repo/a.ts', 0, ''),
    ].join('\n');
    const result = parseRipgrepJsonStream(stdout, 1, 0, value => value.replace('/repo/', ''));
    expect(result.totalMatches).toBe(2);
    expect(result.returnedMatches).toBe(1);
    expect(result.omittedMatches).toBe(1);
    expect(result.matches.every(match => match.file === 'a.ts')).toBe(true);
  });

  it('attaches preceding context within window', () => {
    const stdout = [
      event('begin', '/repo/a.ts', 0, ''),
      event('context', '/repo/a.ts', 1, 'before'),
      event('match', '/repo/a.ts', 2, 'needle'),
      event('end', '/repo/a.ts', 0, ''),
    ].join('\n');
    const result = parseRipgrepJsonStream(stdout, 50, 2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({isContext: true, content: 'before'});
    expect(result.matches[1]).toMatchObject({isContext: false, content: 'needle'});
  });
});