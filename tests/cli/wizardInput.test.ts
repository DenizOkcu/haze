import {describe, expect, it} from 'vitest';
import {commaList, commandParts, isValidUrl, isYesConfirmation} from '../../src/cli/commands/wizardInput.js';

describe('wizard input helpers', () => {
  it('parses comma-separated values', () => {
    expect(commaList(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
  });

  it('parses command parts', () => {
    expect(commandParts(' npx  -y pkg ')).toEqual(['npx', '-y', 'pkg']);
  });

  it('checks confirmations and urls', () => {
    expect(isYesConfirmation(' YES ')).toBe(true);
    expect(isYesConfirmation('no')).toBe(false);
    expect(isValidUrl('https://example.com/v1')).toBe(true);
    expect(isValidUrl('not a url')).toBe(false);
  });
});
