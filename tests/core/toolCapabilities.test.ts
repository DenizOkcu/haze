import {describe, expect, it} from 'vitest';
import {hasCapability, isMutatingCapability, isReadOrDiscoveryCapability, isValidationCapable, toolCapability} from '../../src/core/agent/toolCapabilities.js';

describe('tool capability metadata', () => {
  it('maps built-in tools to their static capabilities', () => {
    expect(toolCapability('listFiles')).toEqual(['discovery']);
    expect(toolCapability('grep')).toEqual(['discovery']);
    expect(toolCapability('readFile')).toEqual(['read']);
    expect(toolCapability('readToolOutput')).toEqual(['read']);
    expect(toolCapability('fetch')).toEqual(['read']);
    expect(toolCapability('writeFile')).toEqual(['mutate']);
    expect(toolCapability('editFile')).toEqual(['mutate']);
    expect(toolCapability('replaceLines')).toEqual(['mutate']);
    expect(toolCapability('bash')).toEqual(['process']);
    expect(toolCapability('process')).toEqual(['process']);
    expect(toolCapability('writeTasks')).toEqual(['coordinate']);
    expect(toolCapability('subagent')).toEqual(['coordinate']);
  });

  it('returns an empty set for unknown / third-party (MCP) tool names', () => {
    expect(toolCapability('someMcpTool')).toEqual([]);
    expect(toolCapability('')).toEqual([]);
  });

  it('classifies mutating and validation-capable tools', () => {
    expect(isMutatingCapability('writeFile')).toBe(true);
    expect(isMutatingCapability('editFile')).toBe(true);
    expect(isMutatingCapability('replaceLines')).toBe(true);
    expect(isMutatingCapability('readFile')).toBe(false);
    // bash is process-capable and validation is runtime-classifier dependent,
    // so it counts as validation-capable (the command decides per call).
    expect(isValidationCapable('bash')).toBe(true);
    expect(isValidationCapable('readFile')).toBe(false);
  });

  it('recognizes read/discovery-only tools', () => {
    expect(isReadOrDiscoveryCapability('listFiles')).toBe(true);
    expect(isReadOrDiscoveryCapability('readFile')).toBe(true);
    expect(isReadOrDiscoveryCapability('grep')).toBe(true);
    expect(isReadOrDiscoveryCapability('bash')).toBe(false);
    expect(isReadOrDiscoveryCapability('writeFile')).toBe(false);
    expect(hasCapability('readFile', 'read')).toBe(true);
    expect(hasCapability('writeFile', 'read')).toBe(false);
  });
});
