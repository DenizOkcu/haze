import {describe, expect, it} from 'vitest';
import {safeToolFailureDetails} from '../../src/core/agent/toolResults.js';

describe('safeToolFailureDetails', () => {
  it('extracts bounded diagnostics from Haze structured failures', () => {
    expect(safeToolFailureDetails({
      ok: false,
      toolName: 'readFile',
      recoverable: true,
      reasonCode: 'path_not_found',
      error: `missing\n${'x'.repeat(600)}`,
    })).toEqual({
      errorCode: 'path_not_found',
      error: `missing ${'x'.repeat(491)}…`,
    });
  });

  it('classifies failed built-in commands without exposing command output', () => {
    expect(safeToolFailureDetails({ok: false, exitCode: 2, stderr: 'token=secret'})).toEqual({errorCode: 'nonzero_exit'});
    expect(safeToolFailureDetails({ok: false, timedOut: true, stderr: 'private'})).toEqual({errorCode: 'command_timed_out'});
  });

  it('does not expose generic third-party failure output', () => {
    expect(safeToolFailureDetails({ok: false, error: 'remote secret'})).toEqual({});
    expect(safeToolFailureDetails({ok: false, toolName: 'mcp', recoverable: true, reasonCode: 'bad value!', error: 'safe'})).toEqual({error: 'safe'});
  });
});
