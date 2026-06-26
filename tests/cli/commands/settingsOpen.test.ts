import {describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {CommandContext} from '../../../src/cli/commands/commands.js';

// Route settings writes at a temp file so /settings open never touches the
// real ~/.haze/settings.json. openPath() no-ops under VITEST, so we only assert
// the file is ensured and the opened path is reported.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-settings-open-'));
const tmpSettings = path.join(tmp, 'settings.json');

const mocks = vi.hoisted(() => ({writeSettings: vi.fn()}));
vi.mock('../../../src/config/settings.js', async () => {
  const actual = await import('../../../src/config/settings.js');
  return {...actual, SETTINGS_FILE: tmpSettings, writeSettings: mocks.writeSettings};
});

const {handleSlashCommand} = await import('../../../src/cli/commands/commands.js');

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    settings: {provider: 'openrouter', apiKey: 'k', model: 'm'},
    contextFiles: [],
    setMode: vi.fn(),
    addSystemMessage: vi.fn(),
    clearConversation: vi.fn(),
    runAgentTurn: vi.fn(),
    refreshContextFiles: vi.fn(() => Promise.resolve([])),
    updateSettings: vi.fn(() => Promise.resolve({})),
    ...overrides,
  };
}

describe('handleSlashCommand /settings open', () => {
  it('ensures the settings file exists and reports the opened path', async () => {
    mocks.writeSettings.mockResolvedValue(undefined);
    // The temp settings file does not exist yet, so ensureSettingsFile must write it.
    const ctx = mockContext();
    expect(await handleSlashCommand('/settings open', ctx)).toBe('handled');
    expect(mocks.writeSettings).toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining(tmpSettings));
  });

  it('does not rewrite the settings file when it already exists', async () => {
    await fs.writeJson(tmpSettings, {provider: 'openrouter'});
    mocks.writeSettings.mockClear();
    const ctx = mockContext();
    expect(await handleSlashCommand('/settings edit', ctx)).toBe('handled');
    expect(mocks.writeSettings).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining(tmpSettings));
  });
});