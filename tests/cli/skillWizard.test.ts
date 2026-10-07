import {describe, expect, it} from 'vitest';
import {selectSkillActionResult, selectSkillResult, skillInfoMessage, skillConfirmRemoveResult} from '../../src/cli/commands/skillsWizard.js';
import type {LoadedSkill} from '../../src/skills/types.js';

const skill: LoadedSkill = {name: 'review', description: 'Review code', dir: '/tmp/review', body: 'body', references: [], source: 'global'};

describe('skill wizard helpers', () => {
  it('selects add, existing, and missing skills', () => {
    expect(selectSkillResult([skill], 'add skill')).toMatchObject({mode: 'skillsAddName', clearDraft: true});
    expect(selectSkillResult([skill], 'review')).toMatchObject({mode: 'skillsAction', selectedName: 'review'});
    expect(selectSkillResult([skill], 'missing')).toMatchObject({mode: 'chat', message: expect.stringContaining('No skill named')});
  });

  it('formats skill info', () => {
    expect(skillInfoMessage({}, skill)).toContain('State: enabled');
    expect(skillInfoMessage({skills: [{name: 'review', enabled: false}]}, skill)).toContain('State: disabled');
  });

  it('protects plugin package skills in both removal paths while allowing scoped disable', () => {
    const plugin: LoadedSkill = {...skill, name: 'demo:review', pluginName: 'demo', source: 'project'};
    const action = selectSkillActionResult({}, [plugin], plugin.name, 'remove skill');
    const confirmation = skillConfirmRemoveResult({}, [plugin], plugin.name, 'yes');
    for (const result of [action, confirmation]) {
      expect(result).toMatchObject({mode: 'chat', message: 'Use /plugin remove demo or disable this skill'});
      expect(result).not.toHaveProperty('removedDir');
      expect(result).not.toHaveProperty('settingsPatch');
    }
    expect(selectSkillActionResult({}, [plugin], plugin.name, 'disable').settingsPatch?.skills).toEqual([{name: 'demo:review', scope: 'project', enabled: false}]);
  });

  it('handles actions', () => {
    expect(selectSkillActionResult({}, [skill], 'review', 'disable').settingsPatch?.skills).toEqual([{name: 'review', enabled: false}]);
    expect(selectSkillActionResult({}, [skill], 'review', 'validate')).toMatchObject({validate: true});
    expect(selectSkillActionResult({}, [skill], 'review', 'remove skill')).toMatchObject({mode: 'skillsConfirmRemove'});
  });
});
