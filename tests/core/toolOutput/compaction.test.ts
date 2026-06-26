import {describe, expect, it} from 'vitest';
import {
  COMPACT_COMMAND_CHARS,
  compactJsonValue,
  compactResultOutput,
  compactStoredOutput,
  pickReductionMetadata,
  REDUCTION_METADATA_KEYS,
} from '../../../src/core/toolOutput/compaction.js';
import {readToolOutput} from '../../../src/core/agent/toolOutputStore.js';

describe('compaction', () => {
  describe('compactStoredOutput', () => {
    it('leaves short text unchanged and untruncated', () => {
      const result = compactStoredOutput('short', 100);
      expect(result).toEqual({text: 'short', truncated: false});
    });

    it('caps oversized text behind a retrievable handle with head + tail', () => {
      const text = 'A'.repeat(COMPACT_COMMAND_CHARS + 500);
      const result = compactStoredOutput(text);
      expect(result.truncated).toBe(true);
      expect(result.omittedChars).toBe(500);
      expect(typeof result.handle).toBe('string');
      expect(result.text).toContain(result.handle as string);
      expect(result.text).toContain('characters omitted');
      // head + tail preserved, middle omitted
      expect(result.text.startsWith('A'.repeat(Math.floor(COMPACT_COMMAND_CHARS * 0.4)))).toBe(true);

      const page = readToolOutput(result.handle as string, 0, 50_000);
      expect(page?.content).toBe(text);
    });

    it('respects a custom maxChars budget', () => {
      const result = compactStoredOutput('0123456789ABCDEF', 10);
      expect(result.truncated).toBe(true);
      expect(result.omittedChars).toBe(6);
    });
  });

  describe('compactJsonValue', () => {
    it('omits non-object values with a marker', () => {
      expect(compactJsonValue('raw string', 'bash')).toEqual({
        compacted: true,
        toolName: 'bash',
        summary: 'Older successful tool result omitted.',
      });
      expect(compactJsonValue([1, 2, 3], 'bash')).toEqual({
        compacted: true,
        toolName: 'bash',
        summary: 'Older successful tool result omitted.',
      });
    });

    it('keeps status fields and drops raw content', () => {
      const value = {
        ok: true,
        path: 'a.ts',
        code: 0,
        content: 'x'.repeat(2000),
        extra: 'dropped',
      };
      const compacted = compactJsonValue(value, 'readFile') as Record<string, unknown>;
      expect(compacted.compacted).toBe(true);
      expect(compacted.toolName).toBe('readFile');
      expect(compacted.ok).toBe(true);
      expect(compacted.path).toBe('a.ts');
      expect(compacted.code).toBe(0);
      expect(compacted.content).toBeUndefined();
      expect(compacted.extra).toBeUndefined();
    });

    it('summarises stdout/stderr streams via the shared reduction-metadata contract', () => {
      const value = {
        ok: true,
        stdout: {
          handle: 'output-1',
          rawHandle: 'output-1',
          filterName: 'node-test',
          reducerName: 'validation',
          contentKind: 'log',
          lossy: false,
          truncated: true,
          omittedChars: 42,
          rawTokensEstimate: 100,
          returnedTokensEstimate: 20,
          estimatedSavedTokens: 80,
          savingsPct: 80,
          rawChars: 400, // not part of the stream contract
          content: 'NOISE'.repeat(1000), // raw content, must be dropped
        },
      };
      const compacted = compactJsonValue(value, 'bash') as {stdout: Record<string, unknown>};
      const stream = compacted.stdout;
      expect(stream.handle).toBe('output-1');
      expect(stream.rawHandle).toBe('output-1');
      expect(stream.filterName).toBe('node-test');
      expect(stream.reducerName).toBe('validation');
      expect(stream.contentKind).toBe('log');
      expect(stream.lossy).toBe(false);
      expect(stream.truncated).toBe(true);
      expect(stream.omittedChars).toBe(42);
      expect(stream.estimatedSavedTokens).toBe(80);
      expect(stream.savingsPct).toBe(80);
      expect(stream.rawChars).toBeUndefined();
      expect(stream.content).toBeUndefined();
    });

    it('skips streams that are not objects', () => {
      const compacted = compactJsonValue({ok: true, stdout: 'plain'}, 'bash') as Record<string, unknown>;
      expect(compacted.stdout).toBeUndefined();
    });
  });

  describe('compactResultOutput', () => {
    it('compacts json envelopes via compactJsonValue', () => {
      const out = compactResultOutput({type: 'json', value: {ok: true, content: 'x'.repeat(2000)}}, 'readFile') as {
        type: string;
        value: Record<string, unknown>;
      };
      expect(out.type).toBe('json');
      expect(out.value.compacted).toBe(true);
      expect(out.value.ok).toBe(true);
      expect(out.value.content).toBeUndefined();
    });

    it('replaces text envelopes with an omission marker', () => {
      const out = compactResultOutput({type: 'text', value: 'x'.repeat(2000)}, 'bash') as {
        type: string;
        value: string;
      };
      expect(out.type).toBe('text');
      expect(out.value).toContain('bash');
      expect(out.value).toContain('omitted');
    });

    it('returns non-envelope values unchanged', () => {
      const out = {type: 'other', value: 1};
      expect(compactResultOutput(out, 'bash')).toBe(out);
    });
  });

  describe('pickReductionMetadata', () => {
    it('keeps only typed reduction-metadata fields and ignores everything else', () => {
      const picked = pickReductionMetadata({
        handle: 'output-1',
        truncated: true,
        omittedChars: 9,
        lossy: 'yes', // wrong type → dropped
        content: 'NOISE',
        unknown: 'ignored',
      });
      expect(picked).toEqual({handle: 'output-1', truncated: true, omittedChars: 9});
    });

    it('every reduction-metadata key is selectable with the right type', () => {
      const full = {
        handle: 'h',
        rawHandle: 'rh',
        filterName: 'f',
        reducerName: 'r',
        contentKind: 'log',
        lossy: true,
        truncated: false,
        omittedChars: 1,
        rawTokensEstimate: 2,
        returnedTokensEstimate: 3,
        estimatedSavedTokens: 4,
        savingsPct: 5,
      };
      const picked = pickReductionMetadata(full);
      for (const key of REDUCTION_METADATA_KEYS) {
        expect(picked[key]).toBe(full[key]);
      }
    });
  });
});