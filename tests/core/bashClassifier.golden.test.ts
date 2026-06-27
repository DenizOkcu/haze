import {describe, expect, it} from 'vitest';
import {classifyBashCommand} from '../../src/core/safety/bashClassifier.js';
import golden from './__snapshots__/bashClassifier.golden.json' assert {type: 'json'};

describe('bash classifier golden outputs', () => {
  it('matches the regression corpus snapshot', () => {
    for (const [command, expected] of Object.entries(golden)) {
      const actual = classifyBashCommand(command);
      expect(actual, `classification mismatch for: ${command || '<empty>'}`).toEqual(expected);
    }
  });
});
