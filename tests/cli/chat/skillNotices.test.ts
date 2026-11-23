import {describe, expect, it, vi} from 'vitest';
import {loadSkillsWithNotices, initialSkillNoticeState} from '../../../src/cli/chat/skillNotices.js';
import {createPickerOpeners, type PickerOpenerDeps} from '../../../src/cli/chat/pickerOpeners.js';

vi.mock('../../../src/skills/SkillRegistry.js', () => ({loadSkillRegistry: vi.fn()}));
vi.mock('../../../src/core/session/sessionStore.js', () => ({listSessions: vi.fn()}));
vi.mock('../../../src/cli/commands/sessionPicker.js', () => ({MAX_SESSION_PICKER_RESULTS: 2}));
vi.mock('../../../src/cli/commands/pluginCommand.js', () => ({listInstalledPlugins: vi.fn()}));

const registry = {candidates: undefined, skills: new Map(), errors: [] as {directory: string; message: string; source?: string}[], notices: [] as string[]};

describe('skillNotices', () => {
  it('announces each changed notice once and keeps its signature', async () => {
    const {loadSkillRegistry} = await import('../../../src/skills/SkillRegistry.js');
    const skill = {name: 'review', path: '/w/.haze/skills/review/SKILL.md', source: 'project'};
    Object.assign(registry, {skills: new Map([['review', skill]]), errors: [{source: 'global', directory: '/h/.haze/skills/bad', message: 'broken'}], notices: ['shadowed']});
    vi.mocked(loadSkillRegistry).mockResolvedValue(registry as never);
    const first = await loadSkillsWithNotices(initialSkillNoticeState());
    expect(first.skills).toEqual([skill]);
    expect(first.messages).toEqual([
      'Project skills discovered (repository-provided, untrusted content): review',
      'Invalid skills were isolated:\nglobal//h/.haze/skills/bad: broken',
      'shadowed',
    ]);
    const second = await loadSkillsWithNotices(first.state);
    expect(second.messages).toEqual([]);
    const cleared = await loadSkillsWithNotices({...first.state, project: ''});
    expect(cleared.messages).toEqual(['Project skills discovered (repository-provided, untrusted content): review']);
  });
});

describe('pickerOpeners', () => {
  function deps() {
    const d = {
      flush: vi.fn(async () => undefined),
      onFlushError: vi.fn(),
      setSessions: vi.fn(),
      updateWizard: vi.fn(),
      setMode: vi.fn(),
      setMessages: vi.fn(),
    };
    return d as unknown as PickerOpenerDeps & typeof d;
  }

  it('reports a flush failure and stays in chat when there are no sessions', async () => {
    const {listSessions} = await import('../../../src/core/session/sessionStore.js');
    vi.mocked(listSessions).mockResolvedValue([]);
    const d = deps();
    d.flush.mockRejectedValue(new Error('disk'));
    await createPickerOpeners(d).openSessionPicker();
    expect(d.onFlushError).toHaveBeenCalledWith(new Error('disk'));
    expect(d.setMode).toHaveBeenCalledWith('chat');
  });

  it('reports a plugin listing failure without opening the picker', async () => {
    const {listInstalledPlugins} = await import('../../../src/cli/commands/pluginCommand.js');
    vi.mocked(listInstalledPlugins).mockRejectedValue(new Error('nope'));
    const d = deps();
    await createPickerOpeners(d).openPluginPicker();
    expect(d.setMode).not.toHaveBeenCalled();
    expect(d.setMessages).toHaveBeenCalledWith(expect.any(Function));
  });
});
