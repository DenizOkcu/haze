import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {CommandContext} from '../../../src/cli/commands/commands.js';

let tmp = '';
let doctorModule: typeof import('../../../src/cli/commands/doctorCommand.js');

const mocks = vi.hoisted(() => ({
  commandExists: vi.fn<[], Promise<boolean>>(),
  readContextFiles: vi.fn<[], Promise<import('../../../src/config/contextFiles.js').ContextFile[]>>(),
  loadSkillRegistry: vi.fn<[], Promise<import('../../../src/skills/types.js').SkillRegistry>>(),
}));

async function loadDoctor() {
  vi.doMock('../../../src/config/paths.js', () => ({
    HAZE_DIR: tmp,
    GLOBAL_SKILLS_DIR: path.join(tmp, 'skills'),
  }));
  vi.doMock('../../../src/config/lspSettings.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/config/lspSettings.js')>('../../../src/config/lspSettings.js');
    return {...actual, commandExists: mocks.commandExists};
  });
  vi.doMock('../../../src/config/contextFiles.js', async () => {
    const actual = await vi.importActual<typeof import('../../../src/config/contextFiles.js')>('../../../src/config/contextFiles.js');
    return {...actual, readContextFiles: mocks.readContextFiles};
  });
  vi.doMock('../../../src/skills/SkillRegistry.js', () => ({
    loadSkillRegistry: mocks.loadSkillRegistry,
  }));
  vi.resetModules();
  return import('../../../src/cli/commands/doctorCommand.js');
}

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    settings: {},
    contextFiles: [],
    setMode: vi.fn(),
    addSystemMessage: vi.fn(),
    clearConversation: vi.fn(),
    runAgentTurn: vi.fn(),
    refreshContextFiles: vi.fn(() => Promise.resolve([])),
    updateSettings: vi.fn(() => Promise.resolve({model: 'new-model'})),
    ...overrides,
  };
}

describe('doctorCommand', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-doctor-cmd-test-'));
    mocks.commandExists.mockResolvedValue(true);
    mocks.readContextFiles.mockResolvedValue([]);
    mocks.loadSkillRegistry.mockResolvedValue({skills: new Map()});
    doctorModule = await loadDoctor();
  });

  afterEach(async () => {
    await fs.remove(tmp);
    vi.clearAllMocks();
  });

  describe('formatDoctorReport', () => {
    it('groups results by severity and counts them', () => {
      const report = doctorModule.formatDoctorReport([
        {name: 'a', severity: 'ok', message: 'ok-msg'},
        {name: 'b', severity: 'critical', message: 'crit-msg'},
        {name: 'c', severity: 'warning', message: 'warn-msg', hint: 'do this'},
      ]);
      expect(report).toContain('1 critical, 1 warning, 3 total');
      expect(report.indexOf('❌')).toBeLessThan(report.indexOf('⚠️'));
      expect(report.indexOf('⚠️')).toBeLessThan(report.indexOf('✅'));
      expect(report).toContain('💡 do this');
    });
  });

  describe('runDoctorChecks', () => {
    it('runs all read-only checks by default', async () => {
      const results = await doctorModule.runDoctorChecks({});
      expect(results.length).toBeGreaterThanOrEqual(9);
      const names = results.map(r => r.name);
      expect(names).toContain('provider configured');
      expect(names).toContain('activeModel resolves');
    });

    it('includes reachability only with --full', async () => {
      const withoutFull = await doctorModule.runDoctorChecks({});
      expect(withoutFull.map(r => r.name)).not.toContain('provider reachable');
      const withFull = await doctorModule.runDoctorChecks({}, {full: true});
      expect(withFull.map(r => r.name)).toContain('provider reachable');
    });
  });

  describe('handleDoctorCommand', () => {
    it('handles /doctor', async () => {
      const ctx = mockContext();
      expect(await doctorModule.handleDoctorCommand('', ctx)).toBe('handled');
      expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Doctor report'));
    });

    it('handles /doctor --full', async () => {
      const ctx = mockContext();
      expect(await doctorModule.handleDoctorCommand('--full', ctx)).toBe('handled');
      expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Doctor report'));
    });
  });
});
