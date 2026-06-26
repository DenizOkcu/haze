import {describe, expect, it} from 'vitest';
import {selectSkillActionResult, selectSkillResult, skillInfoMessage} from '../../src/cli/commands/skillWizard.js';
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

  it('handles actions', () => {
    expect(selectSkillActionResult({}, [skill], 'review', 'disable').settingsPatch?.skills).toEqual([{name: 'review', enabled: false}]);
    expect(selectSkillActionResult({}, [skill], 'review', 'validate')).toMatchObject({validate: true});
    expect(selectSkillActionResult({}, [skill], 'review', 'remove skill')).toMatchObject({mode: 'skillsConfirmRemove'});
  });
});
