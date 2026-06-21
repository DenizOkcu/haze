import {describe, expect, it} from 'vitest';
import {toolOnlyStepCount, uniqueRepeatedToolNames} from '../../src/cli/commands/streaming.js';

describe('uniqueRepeatedToolNames', () => {
  it('flags a tool called twice with identical input', () => {
    const calls = [
      {toolName: 'readFile', input: {path: 'a.ts'}},
      {toolName: 'readFile', input: {path: 'a.ts'}},
    ];
    expect(uniqueRepeatedToolNames(calls)).toEqual(['readFile']);
  });

  it('does not flag the same tool called with different input', () => {
    const calls = [
      {toolName: 'readFile', input: {path: 'a.ts'}},
      {toolName: 'readFile', input: {path: 'b.ts'}},
    ];
    expect(uniqueRepeatedToolNames(calls)).toEqual([]);
  });

  it('returns each repeated name once even if it repeats several times', () => {
    const calls = [
      {toolName: 'bash', input: {command: 'ls'}},
      {toolName: 'bash', input: {command: 'ls'}},
      {toolName: 'bash', input: {command: 'ls'}},
    ];
    expect(uniqueRepeatedToolNames(calls)).toEqual(['bash']);
  });

  it('does not conflate different tools that share identical input', () => {
    const calls = [
      {toolName: 'readFile', input: {path: 'a.ts'}},
      {toolName: 'grep', input: {path: 'a.ts'}},
    ];
    expect(uniqueRepeatedToolNames(calls)).toEqual([]);
  });

  it('tracks several repeated tool names independently', () => {
    const calls = [
      {toolName: 'readFile', input: {path: 'a'}},
      {toolName: 'bash', input: {command: 'x'}},
      {toolName: 'readFile', input: {path: 'a'}},
      {toolName: 'bash', input: {command: 'x'}},
    ];
    expect(uniqueRepeatedToolNames(calls).sort()).toEqual(['bash', 'readFile']);
  });
});

describe('toolOnlyStepCount', () => {
  it('counts consecutive trailing steps that have tool calls and no text', () => {
    const steps = [
      {toolCalls: [{}], text: 'thinking about the task'},
      {toolCalls: [{}], text: ''},
      {toolCalls: [{}], text: '   '},
    ];
    expect(toolOnlyStepCount(steps)).toBe(2);
  });

  it('stops scanning backwards at the first step that emitted text', () => {
    const steps = [
      {toolCalls: [{}], text: 'summary'},
      {toolCalls: [{}], text: ''},
    ];
    expect(toolOnlyStepCount(steps)).toBe(1);
  });

  it('stops at a step with no tool calls', () => {
    const steps = [
      {toolCalls: [], text: ''},
      {toolCalls: [{}], text: ''},
    ];
    expect(toolOnlyStepCount(steps)).toBe(1);
  });

  it('returns 0 when the most recent step has text', () => {
    expect(toolOnlyStepCount([{toolCalls: [{}], text: 'finalizing.'}])).toBe(0);
  });

  it('returns 0 for an empty step list', () => {
    expect(toolOnlyStepCount([])).toBe(0);
  });
});
