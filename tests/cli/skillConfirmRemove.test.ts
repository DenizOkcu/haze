import {describe, expect, it} from 'vitest';
import {skillConfirmRemoveResult} from '../../src/cli/commands/skillConfirmRemove.js';
import type {LoadedSkill} from '../../src/skills/types.js';

const skill: LoadedSkill = {name: 'review', description: 'd', dir: '/tmp/review', body: 'b', references: [], source: 'global'};

describe('skill confirm remove', () => {
  it('requires a selected name', () => {
    expect(skillConfirmRemoveResult({}, [skill], undefined, 'yes')).toEqual({mode: 'chat'});
  });

  it('cancels when confirmation is no', () => {
    expect(skillConfirmRemoveResult({}, [skill], 'review', 'no')).toMatchObject({mode: 'chat', message: 'Cancelled. Skill not removed.'});
  });

  it('reports missing skills', () => {
    expect(skillConfirmRemoveResult({}, [], 'review', 'yes')).toMatchObject({mode: 'chat', message: 'Skill review not found.'});
  });

  it('builds remove settings patch when confirmed', () => {
    expect(skillConfirmRemoveResult({skills: [{name: 'review'}]}, [skill], 'review', 'yes')).toMatchObject({
      mode: 'chat',
      message: 'Removed skill review.',
      settingsPatch: {skills: []},
    });
  });
});